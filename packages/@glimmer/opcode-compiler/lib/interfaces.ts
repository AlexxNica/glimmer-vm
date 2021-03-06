import {
  VMHandle,
  Opaque,
  SymbolTable,
  Option,
  BlockSymbolTable,
  ComponentCapabilities,
  CompileTimeProgram,
  Recast
} from '@glimmer/interfaces';
import { Core, SerializedTemplateBlock } from '@glimmer/wire-format';
import { Macros } from './syntax';

export interface EagerResolver<Locator> {
  getCapabilities(locator: Locator): ComponentCapabilities;
}

export interface EagerCompilationOptions<TemplateMeta, R extends EagerResolver<TemplateMeta>> {
  resolver: R;
  program: CompileTimeProgram;
  macros: Macros;
}

export interface CompilableTemplate<S extends SymbolTable> {
  symbolTable: S;
  compile(): VMHandle;
}

export const PLACEHOLDER_HANDLE: VMHandle = -1 as Recast<number, VMHandle>;

export type CompilableBlock = CompilableTemplate<BlockSymbolTable>;

export type Primitive = undefined | null | boolean | number | string;

export type ComponentArgs = [Core.Params, Core.Hash, Option<CompilableBlock>, Option<CompilableBlock>];
export type TemplateMeta = Opaque;

export interface ComponentBuilder {
  static(definition: number, args: ComponentArgs): void;
}

export interface ParsedLayout<TemplateMeta = Opaque> {
  id?: Option<string>;
  block: SerializedTemplateBlock;
  referrer: TemplateMeta;
}
