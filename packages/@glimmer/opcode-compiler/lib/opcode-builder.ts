import {
  Opaque,
  Option,
  ProgramSymbolTable,
  SymbolTable,
  Recast,
  VMHandle,
  BlockSymbolTable,
  ComponentCapabilities,
  CompileTimeConstants,
  CompileTimeProgram,
  CompileTimeLazyConstants,
  CompileTimeHeap
} from "@glimmer/interfaces";
import { dict, EMPTY_ARRAY, expect, Stack, unreachable } from '@glimmer/util';
import { Op, Register } from '@glimmer/vm';
import * as WireFormat from '@glimmer/wire-format';
import { SerializedInlineBlock } from "@glimmer/wire-format";
import { PrimitiveType } from "@glimmer/program";

import {
  Primitive,
  CompilableBlock,
  ParsedLayout
} from './interfaces';

import {
  ATTRS_BLOCK,
  Macros,
  Compilers,
  expressionCompiler
} from './syntax';

import CompilableTemplate, { ICompilableTemplate, PLACEHOLDER_HANDLE } from './compilable-template';

import {
  ComponentBuilder
} from './wrapped-component';
import { InstructionEncoder, Operand } from "@glimmer/encoder";

export type Label = string;

type TargetOpcode = Op.Jump | Op.JumpIf | Op.JumpUnless | Op.EnterList | Op.Iterate | Op.ReturnTo;

class Labels {
  labels = dict<number>();
  targets: Array<{ at: number, Target: TargetOpcode, target: string }> = [];

  label(name: string, index: number) {
    this.labels[name] = index;
  }

  target(at: number, Target: TargetOpcode, target: string) {
    this.targets.push({ at, Target, target });
  }

  patch(encoder: InstructionEncoder): void {
    let { targets, labels } = this;
    for (let i = 0; i < targets.length; i++) {
      let { at, target } = targets[i];
      let address = labels[target] - at;
      encoder.patch(at, address);
    }
  }
}

export interface AbstractTemplate<S extends SymbolTable = SymbolTable> {
  symbolTable: S;
}

export interface CompileTimeLookup<TemplateMeta> {
  getCapabilities(handle: number): ComponentCapabilities;
  getLayout(handle: number): Option<ICompilableTemplate<ProgramSymbolTable>>;

  // This interface produces module locators (and indicates if a name is present), but does not
  // produce any actual objects. The main use-case for producing objects is handled above,
  // with getCapabilities and getLayout, which drastically shrinks the size of the object
  // that the core interface is forced to reify.
  lookupHelper(name: string, referrer: TemplateMeta): Option<number>;
  lookupModifier(name: string, referrer: TemplateMeta): Option<number>;
  lookupComponentDefinition(name: string, referrer: TemplateMeta): Option<number>;
  lookupPartial(name: string, referrer: TemplateMeta): Option<number>;
}

export interface Blocks {
  main: Option<CompilableBlock>;
  else: Option<CompilableBlock>;
  attrs: Option<CompilableBlock>;
}

export interface OpcodeBuilderConstructor {
  new<TemplateMeta>(program: CompileTimeProgram,
      lookup: CompileTimeLookup<TemplateMeta>,
      meta: Opaque,
      macros: Macros,
      containingLayout: ParsedLayout,
      asPartial: boolean): OpcodeBuilder<TemplateMeta>;
}

export class SimpleOpcodeBuilder {
  protected encoder = new InstructionEncoder([]);

  push(name: Op, ...ops: Operand[]) {
    let { encoder } = this;
    encoder.encode(name, ...ops);
  }

  commit(heap: CompileTimeHeap, scopeSize: number): VMHandle {
    this.push(Op.Return);

    let { buffer } = this.encoder;

    // TODO: change the whole malloc API and do something more efficient
    let handle = heap.malloc();

    for (let i = 0; i < buffer.length; i++) {
      let value = buffer[i];
      typeof value === 'function' ?
        heap.pushPlaceholder(value) :
        heap.push(value);
    }

    heap.finishMalloc(handle, scopeSize);

    return handle;
  }

  reserve(name: Op, size = 1) {
    let reservedOperands = [];
    for (let i = 0; i < size; i++) {
      reservedOperands[i] = -1;
    }

    this.push(name, ...reservedOperands);
  }

  ///

  main() {
    this.push(Op.Main, Register.s0);
    this.invokePreparedComponent(false);
  }

  dynamicContent(isTrusting: boolean) {
    this.push(Op.DynamicContent, isTrusting ? 1 : 0);
  }

  beginComponentTransaction() {
    this.push(Op.BeginComponentTransaction);
  }

  commitComponentTransaction() {
    this.push(Op.CommitComponentTransaction);
  }

  pushDynamicScope() {
    this.push(Op.PushDynamicScope);
  }

  popDynamicScope() {
    this.push(Op.PopDynamicScope);
  }

  pushRemoteElement() {
    this.push(Op.PushRemoteElement);
  }

  popRemoteElement() {
    this.push(Op.PopRemoteElement);
  }

  pushRootScope(symbols: number, bindCallerScope: boolean) {
    this.push(Op.RootScope, symbols, (bindCallerScope ? 1 : 0));
  }

  pushChildScope() {
    this.push(Op.ChildScope);
  }

  popScope() {
    this.push(Op.PopScope);
  }

  prepareArgs(state: Register) {
    this.push(Op.PrepareArgs, state);
  }

  createComponent(state: Register, hasDefault: boolean) {
    let flag = (hasDefault as any) | 0;
    this.push(Op.CreateComponent, flag, state);
  }

  registerComponentDestructor(state: Register) {
    this.push(Op.RegisterComponentDestructor, state);
  }

  putComponentOperations() {
    this.push(Op.PutComponentOperations);
  }

  getComponentSelf(state: Register) {
    this.push(Op.GetComponentSelf, state);
  }

  getComponentTagName(state: Register) {
    this.push(Op.GetComponentTagName, state);
  }

  getComponentLayout(state: Register) {
    this.push(Op.GetComponentLayout, state);
  }

  invokeComponentLayout(state: Register) {
    this.push(Op.InvokeComponentLayout, state);
  }

  didCreateElement(state: Register) {
    this.push(Op.DidCreateElement, state);
  }

  didRenderLayout(state: Register) {
    this.push(Op.DidRenderLayout, state);
  }

  pushFrame() {
    this.push(Op.PushFrame);
  }

  popFrame() {
    this.push(Op.PopFrame);
  }

  invokeVirtual(): void {
    this.push(Op.InvokeVirtual);
  }

  invokeYield(): void {
    this.push(Op.InvokeYield);
  }

  toBoolean() {
    this.push(Op.ToBoolean);
  }

  invokePreparedComponent(hasBlock: boolean, populateLayout: Option<() => void> = null) {
    this.beginComponentTransaction();
    this.pushDynamicScope();

    this.createComponent(Register.s0, hasBlock);

    // this has to run after createComponent to allow
    // for late-bound layouts, but a caller is free
    // to populate the layout earlier if it wants to
    // and do nothing here.
    if (populateLayout) populateLayout();

    this.registerComponentDestructor(Register.s0);

    this.getComponentSelf(Register.s0);

    this.invokeComponentLayout(Register.s0);
    this.didRenderLayout(Register.s0);
    this.popFrame();

    this.popScope();
    this.popDynamicScope();
    this.commitComponentTransaction();
  }

  protected get pos(): number {
    return this.encoder.typePos;
  }

  protected get nextPos(): number {
    return this.encoder.size;
  }
}

export type VMHandlePlaceholder = [number, () => VMHandle];

export abstract class OpcodeBuilder<Locator> extends SimpleOpcodeBuilder {
  public constants: CompileTimeConstants;
  public component: ComponentBuilder<Locator> = new ComponentBuilder(this);

  private expressionCompiler: Compilers<WireFormat.TupleExpression> = expressionCompiler();
  private labelsStack = new Stack<Labels>();
  private isComponentAttrs = false;

  constructor(
    public program: CompileTimeProgram,
    public resolver: CompileTimeLookup<Locator>,
    public referrer: Locator,
    public macros: Macros,
    public containingLayout: ParsedLayout,
    public asPartial: boolean
  ) {
    super();
    this.constants = program.constants;
  }

  label(name: string) {
    this.labels.label(name, this.nextPos);
  }

  setComponentAttrs(enabled: boolean): void {
    this.isComponentAttrs = enabled;
  }

  expr(expression: WireFormat.Expression) {
    if (Array.isArray(expression)) {
      this.expressionCompiler.compile(expression, this);
    } else {
      this.pushPrimitiveReference(expression);
    }
  }

  // args

  pushArgs(names: string[], flags: number) {
    let serialized = this.constants.stringArray(names);
    this.push(Op.PushArgs, serialized, flags);
  }

  // helpers

  private get labels(): Labels {
    return expect(this.labelsStack.current, 'bug: not in a label stack');
  }

  startLabels() {
    this.labelsStack.push(new Labels());
  }

  stopLabels() {
    let label = expect(this.labelsStack.pop(), 'unbalanced push and pop labels');
    label.patch(this.encoder);
  }

  // components

  pushComponentDefinition(handle: number) {
    this.push(Op.PushComponentDefinition, this.constants.handle(handle));
  }

  pushDynamicComponentManager(referrer: Locator) {
    this.push(Op.PushDynamicComponentManager, this.constants.serializable(referrer));
  }

  // partial

  invokePartial(referrer: Locator, symbols: string[], evalInfo: number[]) {
    let _meta = this.constants.serializable(referrer);
    let _symbols = this.constants.stringArray(symbols);
    let _evalInfo = this.constants.array(evalInfo);

    this.push(Op.InvokePartial, _meta, _symbols, _evalInfo);
  }

  resolveMaybeLocal(name: string) {
    this.push(Op.ResolveMaybeLocal, this.string(name));
  }

  // debugger

  debugger(symbols: string[], evalInfo: number[]) {
    this.push(Op.Debugger, this.constants.stringArray(symbols), this.constants.array(evalInfo));
  }

  // dom

  text(text: string) {
    this.push(Op.Text, this.constants.string(text));
  }

  openPrimitiveElement(tag: string) {
    this.push(Op.OpenElement, this.constants.string(tag));
  }

  openElementWithOperations(tag: string) {
    this.push(Op.OpenElementWithOperations, this.constants.string(tag));
  }

  openDynamicElement() {
    this.push(Op.OpenDynamicElement);
  }

  flushElement() {
    this.push(Op.FlushElement);
  }

  closeElement() {
    this.push(Op.CloseElement);
  }

  staticAttr(_name: string, _namespace: Option<string>, _value: string) {
    let name = this.constants.string(_name);
    let namespace = _namespace ? this.constants.string(_namespace) : 0;

    if (this.isComponentAttrs) {
      this.pushPrimitiveReference(_value);
      this.push(Op.ComponentAttr, name, 1, namespace);
    } else {
      let value = this.constants.string(_value);
      this.push(Op.StaticAttr, name, value, namespace);
    }
  }

  dynamicAttr(_name: string, _namespace: Option<string>, trusting: boolean) {
    let name = this.constants.string(_name);
    let namespace = _namespace ? this.constants.string(_namespace) : 0;

    if (this.isComponentAttrs) {
      this.push(Op.ComponentAttr, name, (trusting === true ? 1 : 0), namespace);
    } else {
      this.push(Op.DynamicAttr, name, (trusting === true ? 1 : 0), namespace);
    }
  }

  comment(_comment: string) {
    let comment = this.constants.string(_comment);
    this.push(Op.Comment, comment);
  }

  modifier(locator: Locator, params: Option<WireFormat.Core.Params>, hash: Option<WireFormat.Core.Hash>) {
    this.pushFrame();
    this.compileArgs(params, hash, null, true);
    this.push(Op.Modifier, this.constants.handle(locator));
    this.popFrame();
  }

  // lists

  putIterator() {
    this.push(Op.PutIterator);
  }

  enterList(start: string) {
    this.reserve(Op.EnterList);
    this.labels.target(this.pos, Op.EnterList, start);
  }

  exitList() {
    this.push(Op.ExitList);
  }

  iterate(breaks: string) {
    this.reserve(Op.Iterate);
    this.labels.target(this.pos, Op.Iterate, breaks);
  }

  // expressions

  setVariable(symbol: number) {
    this.push(Op.SetVariable, symbol);
  }

  setBlock(symbol: number) {
    this.push(Op.SetBlock, symbol);
  }

  getVariable(symbol: number) {
    this.push(Op.GetVariable, symbol);
  }

  getProperty(key: string) {
    this.push(Op.GetProperty, this.string(key));
  }

  getBlock(symbol: number) {
    this.push(Op.GetBlock, symbol);
  }

  hasBlock(symbol: number) {
    this.push(Op.HasBlock, symbol);
  }

  hasBlockParams(to: number) {
    this.getBlock(to);
    this.resolveBlock();
    this.push(Op.HasBlockParams);
  }

  concat(size: number) {
    this.push(Op.Concat, size);
  }

  load(register: Register) {
    this.push(Op.Load, register);
  }

  fetch(register: Register) {
    this.push(Op.Fetch, register);
  }

  dup(register = Register.sp, offset = 0) {
    return this.push(Op.Dup, register, offset);
  }

  pop(count = 1) {
    return this.push(Op.Pop, count);
  }

  // vm

  returnTo(label: string) {
    this.reserve(Op.ReturnTo);
    this.labels.target(this.pos, Op.ReturnTo, label);
  }

  primitive(_primitive: Primitive) {
    let type: PrimitiveType = PrimitiveType.NUMBER;
    let primitive: number;
    switch (typeof _primitive) {
      case 'number':
        if (_primitive as number % 1 === 0) {
          if (_primitive as number > -1) {
            primitive = _primitive as number;
          } else {
            primitive = this.negative(_primitive as number);
            type = PrimitiveType.NEGATIVE;
          }
        } else {
          primitive = this.float(_primitive as number);
          type = PrimitiveType.FLOAT;
        }
        break;
      case 'string':
        primitive = this.string(_primitive as string);
        type = PrimitiveType.STRING;
        break;
      case 'boolean':
        primitive = (_primitive as any) | 0;
        type = PrimitiveType.BOOLEAN_OR_VOID;
        break;
      case 'object':
        // assume null
        primitive = 2;
        type = PrimitiveType.BOOLEAN_OR_VOID;
        break;
      case 'undefined':
        primitive = 3;
        type = PrimitiveType.BOOLEAN_OR_VOID;
        break;
      default:
        throw new Error('Invalid primitive passed to pushPrimitive');
    }

    this.push(Op.Primitive, primitive << 3 | type);
  }

  float(num: number): number {
    return this.constants.float(num);
  }

  negative(num: number): number {
    return this.constants.negative(num);
  }

  pushPrimitiveReference(primitive: Primitive) {
    this.primitive(primitive);
    this.primitiveReference();
  }

  primitiveReference() {
    this.push(Op.PrimitiveReference);
  }

  helper(helper: Locator, params: Option<WireFormat.Core.Params>, hash: Option<WireFormat.Core.Hash>) {
    this.pushFrame();
    this.compileArgs(params, hash, null, true);
    this.push(Op.Helper, this.constants.handle(helper));
    this.popFrame();
    this.fetch(Register.v0);
  }

  bindDynamicScope(_names: string[]) {
    this.push(Op.BindDynamicScope, this.names(_names));
  }

  enter(args: number) {
    this.push(Op.Enter, args);
  }

  exit() {
    this.push(Op.Exit);
  }

  return() {
    this.push(Op.Return);
  }

  jump(target: string) {
    this.reserve(Op.Jump);
    this.labels.target(this.pos, Op.Jump, target);
  }

  jumpIf(target: string) {
    this.reserve(Op.JumpIf);
    this.labels.target(this.pos, Op.JumpIf, target);
  }

  jumpUnless(target: string) {
    this.reserve(Op.JumpUnless);
    this.labels.target(this.pos, Op.JumpUnless, target);
  }

  // internal helpers

  string(_string: string): number {
    return this.constants.string(_string);
  }

  protected names(_names: string[]): number {
    let names: number[] = [];

    for (let i = 0; i < _names.length; i++) {
      let n = _names[i];
      names[i]= this.constants.string(n);
    }

    return this.constants.array(names);
  }

  protected symbols(symbols: number[]): number {
    return this.constants.array(symbols);
  }

  // convenience methods

  inlineBlock(block: SerializedInlineBlock): CompilableBlock {
    let { parameters, statements } = block;
    let symbolTable = { parameters, referrer: this.containingLayout.referrer };
    let options = {
      program: this.program,
      macros: this.macros,
      Builder: this.constructor as OpcodeBuilderConstructor,
      resolver: this.resolver,
      asPartial: this.asPartial,
      referrer: this.referrer
    };

    return new CompilableTemplate(statements, this.containingLayout, options, symbolTable);
  }

  evalSymbols(): Option<string[]> {
    let { containingLayout: { block } } = this;

    return block.hasEval ? block.symbols : null;
  }

  compileParams(params: Option<WireFormat.Core.Params>) {
    if (!params) return 0;

    for (let i = 0; i < params.length; i++) {
      this.expr(params[i]);
    }

    return params.length;
  }

  compileArgs(params: Option<WireFormat.Core.Params>, hash: Option<WireFormat.Core.Hash>, blocks: Option<Blocks>, synthetic: boolean) {
    if (blocks) {
      this.pushYieldableBlock(blocks.main);
      this.pushYieldableBlock(blocks.else);
      this.pushYieldableBlock(blocks.attrs);
    }

    let count = this.compileParams(params);

    let flags = count << 4;

    if (synthetic) flags |= 0b1000;

    if (blocks) {
      flags |= 0b111;
    }

    let names: string[] = EMPTY_ARRAY;

    if (hash) {
      names = hash[0];
      let val = hash[1];
      for (let i = 0; i < val.length; i++) {
        this.expr(val[i]);
      }
    }

    this.pushArgs(names, flags);
  }

  invokeStaticBlock(block: CompilableBlock, callerCount = 0): void {
    let { parameters } = block.symbolTable;
    let calleeCount = parameters.length;
    let count = Math.min(callerCount, calleeCount);

    this.pushFrame();

    if (count) {
      this.pushChildScope();

      for (let i = 0; i < count; i++) {
        this.dup(Register.fp, callerCount - i);
        this.setVariable(parameters[i]);
      }
    }

    this.pushBlock(block);
    this.resolveBlock();
    this.invokeVirtual();

    if (count) {
      this.popScope();
    }

    this.popFrame();
  }

  guardedAppend(expression: WireFormat.Expression, trusting: boolean) {
    this.startLabels();

    this.pushFrame();

    this.returnTo('END');

    this.expr(expression);

    this.dup();
    this.isComponent();

    this.enter(2);

    this.jumpUnless('ELSE');

    this.pushDynamicComponentManager(this.referrer);
    this.invokeComponent(null, null, null, false, null, null);

    this.exit();

    this.return();

    this.label('ELSE');

    this.dynamicContent(trusting);

    this.exit();

    this.return();

    this.label('END');

    this.popFrame();

    this.stopLabels();
  }

  yield(to: number, params: Option<WireFormat.Core.Params>) {
    this.compileArgs(params, null, null, false);
    this.getBlock(to);
    this.resolveBlock();
    this.invokeYield();
    this.popScope();
    this.popFrame();
  }

  populateLayout(state: number) {
    this.push(Op.PopulateLayout, state);
  }

  invokeComponent(attrs: Option<CompilableBlock>, params: Option<WireFormat.Core.Params>, hash: WireFormat.Core.Hash, synthetic: boolean, block: Option<CompilableBlock>, inverse: Option<CompilableBlock> = null, layout?: ICompilableTemplate<ProgramSymbolTable>) {
    this.fetch(Register.s0);
    this.dup(Register.sp, 1);
    this.load(Register.s0);

    this.pushFrame();

    let blocks = { main: block, else: inverse, attrs };

    this.compileArgs(params, hash, blocks, synthetic);
    this.prepareArgs(Register.s0);

    this.invokePreparedComponent(block !== null, () => {
      if (layout) {
        this.pushSymbolTable(layout.symbolTable);
        this.pushLayout(layout);
        this.resolveLayout();
      } else {
        this.getComponentLayout(Register.s0);
      }

      this.populateLayout(Register.s0);
    });

    this.load(Register.s0);
  }

  invokeStaticComponent(capabilities: ComponentCapabilities, layout: ICompilableTemplate<ProgramSymbolTable>, attrs: Option<CompilableBlock>, params: Option<WireFormat.Core.Params>, hash: WireFormat.Core.Hash, synthetic: boolean, block: Option<CompilableBlock>, inverse: Option<CompilableBlock> = null) {
    let { symbolTable } = layout;

    let bailOut =
      symbolTable.hasEval ||
      capabilities.prepareArgs;

    if (bailOut) {
      this.invokeComponent(attrs, params, hash, synthetic, block, inverse, layout);
      return;
    }

    this.fetch(Register.s0);
    this.dup(Register.sp, 1);
    this.load(Register.s0);

    let { symbols } = symbolTable;

    if (capabilities.createArgs) {
      this.pushFrame();
      this.compileArgs(null, hash, null, synthetic);
    }

    this.beginComponentTransaction();
    this.pushDynamicScope();
    this.createComponent(Register.s0, block !== null);

    if (capabilities.createArgs) {
      this.popFrame();
    }

    this.registerComponentDestructor(Register.s0);

    let bindings: { symbol: number, isBlock: boolean }[] = [];

    this.getComponentSelf(Register.s0);
    bindings.push({ symbol: 0, isBlock: false });

    for (let i = 0; i < symbols.length; i++) {
      let symbol = symbols[i];

      switch (symbol.charAt(0)) {
        case '&':
          let callerBlock: Option<CompilableBlock> = null;

          if (symbol === '&default') {
            callerBlock = block;
          } else if (symbol === '&inverse') {
            callerBlock = inverse;
          } else if (symbol === ATTRS_BLOCK) {
            callerBlock = attrs;
          } else {
            throw unreachable();
          }

          if (callerBlock) {
            this.pushYieldableBlock(callerBlock);
            bindings.push({ symbol: i + 1, isBlock: true });
          } else {
            this.pushYieldableBlock(null);
            bindings.push({ symbol: i + 1, isBlock: true });
          }

          break;

        case '@':
          if (!hash) {
            break;
          }

          let [keys, values] = hash;
          let lookupName = symbol;

          if (synthetic) {
            lookupName = symbol.slice(1);
          }

          let index = keys.indexOf(lookupName);

          if (index !== -1) {
            this.expr(values[index]);
            bindings.push({ symbol: i + 1, isBlock: false });
          }

          break;
      }
    }

    this.pushRootScope(symbols.length + 1, !!(block || inverse || attrs));

    for (let i = bindings.length - 1; i >= 0; i--) {
      let { symbol, isBlock } = bindings[i];

      if (isBlock) {
        this.setBlock(symbol);
      } else {
        this.setVariable(symbol);
      }
    }

    this.pushFrame();

    this.invokeStatic(layout);
    this.didRenderLayout(Register.s0);
    this.popFrame();

    this.popScope();
    this.popDynamicScope();
    this.commitComponentTransaction();

    this.load(Register.s0);
  }

  dynamicComponent(definition: WireFormat.Expression, /* TODO: attrs: Option<RawInlineBlock>, */ params: Option<WireFormat.Core.Params>, hash: WireFormat.Core.Hash, synthetic: boolean, block: Option<CompilableBlock>, inverse: Option<CompilableBlock> = null) {
    this.startLabels();

    this.pushFrame();

    this.returnTo('END');

    this.expr(definition);

    this.dup();

    this.enter(2);

    this.jumpUnless('ELSE');

    this.pushDynamicComponentManager(this.referrer);
    this.invokeComponent(null, params, hash, synthetic, block, inverse);

    this.label('ELSE');
    this.exit();
    this.return();

    this.label('END');
    this.popFrame();

    this.stopLabels();
  }

  isComponent() {
    this.push(Op.IsComponent);
  }

  curryComponent(definition: WireFormat.Expression, /* TODO: attrs: Option<RawInlineBlock>, */ params: Option<WireFormat.Core.Params>, hash: WireFormat.Core.Hash, synthetic: boolean) {
    let referrer = this.referrer;

    this.pushFrame();
    this.compileArgs(params, hash, null, synthetic);
    this.expr(definition);
    this.push(Op.CurryComponent, this.constants.serializable(referrer));
    this.popFrame();
    this.fetch(Register.v0);
  }

  abstract pushBlock(block: Option<CompilableBlock>): void;
  abstract resolveBlock(): void;
  abstract pushLayout(layout: Option<ICompilableTemplate<ProgramSymbolTable>>): void;
  abstract invokeStatic(block: ICompilableTemplate<SymbolTable>): void;
  abstract resolveLayout(): void;

  pushSymbolTable(table: Option<SymbolTable>): void {
    if (table) {
      let constant = this.constants.table(table);
      this.push(Op.PushSymbolTable, constant);
    } else {
      this.primitive(null);
    }
  }

  pushBlockScope(): void {
    this.push(Op.PushBlockScope);
  }

  pushYieldableBlock(block: Option<CompilableBlock>): void {
    this.pushSymbolTable(block && block.symbolTable);
    this.pushBlockScope();
    this.pushBlock(block);
  }

  template(block: Option<WireFormat.SerializedInlineBlock>): Option<CompilableBlock> {
    if (!block) return null;

    return this.inlineBlock(block);
  }
}

export default OpcodeBuilder;

export class LazyOpcodeBuilder<TemplateMeta> extends OpcodeBuilder<TemplateMeta> {
  public constants: CompileTimeLazyConstants;

  pushBlock(block: Option<CompilableBlock>): void {
    if (block) {
      this.pushOther(block);
    } else {
      this.primitive(null);
    }
  }

  resolveBlock(): void {
    this.push(Op.CompileBlock);
  }

  pushLayout(layout: Option<CompilableTemplate<ProgramSymbolTable, TemplateMeta>>) {
    if (layout) {
      this.pushOther(layout);
    } else {
      this.primitive(null);
    }
  }

  resolveLayout(): void {
    this.push(Op.CompileBlock);
  }

  invokeStatic(compilable: ICompilableTemplate<SymbolTable>): void {
    this.pushOther(compilable);
    this.push(Op.CompileBlock);
    this.push(Op.InvokeVirtual);
  }

  protected pushOther<T>(value: T) {
    this.push(Op.Constant, this.other(value));
  }

  protected other(value: Opaque): number {
    return this.constants.other(value);
  }
}

export class EagerOpcodeBuilder<TemplateMeta> extends OpcodeBuilder<TemplateMeta> {
  pushBlock(block: Option<ICompilableTemplate<BlockSymbolTable>>): void {
    let handle = block ? block.compile() as Recast<VMHandle, number> : null;
    this.primitive(handle);
  }

  resolveBlock(): void {
    return;
  }

  pushLayout(layout: Option<CompilableTemplate<ProgramSymbolTable, TemplateMeta>>): void {
    if (layout) {
      this.primitive(layout.compile() as Recast<VMHandle, number>);
    } else {
      this.primitive(null);
    }
  }

  resolveLayout() {}

  invokeStatic(compilable: ICompilableTemplate<SymbolTable>): void {
    let handle = compilable.compile();

    // If the handle for the invoked component is not yet known (for example,
    // because this is a recursive invocation and we're still compiling), push a
    // function that will produce the correct handle when the heap is
    // serialized.
    if (handle === PLACEHOLDER_HANDLE) {
      this.push(Op.InvokeStatic, () => compilable.compile() as Recast<VMHandle, number>);
    } else {
      this.push(Op.InvokeStatic, handle as Recast<VMHandle, number>);
    }
  }
}
