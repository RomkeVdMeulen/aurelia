import { all, DI, IContainer, IDisposable, Immutable, ImmutableArray, inject, IResolver, IServiceLocator, PLATFORM, Reporter, Writable } from '@aurelia/kernel';
import { IEventManager } from '../binding/event-manager';
import { IExpressionParser } from '../binding/expression-parser';
import { IObserverLocator } from '../binding/observer-locator';
import { IHydrateElementInstruction, ITargetedInstruction, ITemplateDefinition, TemplateDefinition, TemplatePartDefinitions } from '../definitions';
import { DOM, INode, INodeSequence, INodeSequenceFactory, IRenderLocation, NodeSequence, NodeSequenceFactory } from '../dom';
import { IAttach, IBindScope, ILifecycleState } from '../lifecycle';
import { IChangeSet, IScope } from '../observation';
import { IResourceDescriptions, IResourceKind, IResourceType, ResourceDescription } from '../resource';
import { ICustomAttribute, ICustomAttributeType } from './custom-attribute';
import { ICustomElement, ICustomElementType } from './custom-element';
import { buildTemplateDefinition } from './definition-builder';
import { IRenderer, Renderer } from './renderer';
import { RuntimeBehavior } from './runtime-behavior';
import { ITemplateCompiler, ViewCompileFlags } from './template-compiler';
import { IViewFactory, ViewFactory } from './view';

export interface IElementTemplateProvider {
  getElementTemplate(renderingEngine: IRenderingEngine, customElementType: ICustomElementType): ITemplate;
}


export interface IRenderingEngine {
  getElementTemplate(definition: TemplateDefinition, componentType?: ICustomElementType): ITemplate;
  getViewFactory(source: Immutable<ITemplateDefinition>, parentContext?: IRenderContext): IViewFactory;

  applyRuntimeBehavior(Type: ICustomAttributeType, instance: ICustomAttribute): void;
  applyRuntimeBehavior(Type: ICustomElementType, instance: ICustomElement): void;

  createRenderer(context: IRenderContext): IRenderer;
}

export const IRenderingEngine = DI.createInterface<IRenderingEngine>()
  .withDefault(x => x.singleton(RenderingEngine));

const defaultCompilerName = 'default';
export interface ILifecycleRender {
  /**
   * Only applies to `@customElement`. This hook is not invoked for `@customAttribute`s
   *
   * Called during `$hydrate`, after `this.$scope` and `this.$projector` are set.
   *
   * If this hook is implemented, it will be used instead of `renderingEngine.getElementTemplate`.
   * This allows you to completely override the default rendering behavior.
   *
   * It is the responsibility of the implementer to:
   * - Populate `this.$bindables` with any Bindings, child Views, custom elements and custom attributes
   * - Populate `this.$attachables` with any child Views, custom elements and custom attributes
   * - Populate `this.$nodes` with the nodes that need to be appended to the host
   * - Populate `this.$context` with the RenderContext / Container scoped to this instance
   *
   * @param host The DOM node that declares this custom element
   * @param parts Replaceable parts, if any
   *
   * @returns Either an implementation of `IElementTemplateProvider`, or void
   *
   * @description
   * This is the first "hydrate" lifecycle hook. It happens only once per instance (contrary to bind/attach
   * which can happen many times per instance), though it can happen many times per type (once for each instance)
   */
  render?(host: INode, parts: Immutable<Pick<IHydrateElementInstruction, 'parts'>>): IElementTemplateProvider | void;
}

@inject(IContainer, IChangeSet, IObserverLocator, IEventManager, IExpressionParser, all(ITemplateCompiler))
/*@internal*/
export class RenderingEngine implements IRenderingEngine {
  private templateLookup: Map<TemplateDefinition, ITemplate> = new Map();
  private factoryLookup: Map<Immutable<ITemplateDefinition>, IViewFactory> = new Map();
  private behaviorLookup: Map<ICustomElementType | ICustomAttributeType, RuntimeBehavior> = new Map();
  private compilers: Record<string, ITemplateCompiler>;

  constructor(
    private container: IContainer,
    private changeSet: IChangeSet,
    private observerLocator: IObserverLocator,
    private eventManager: IEventManager,
    private parser: IExpressionParser,
    templateCompilers: ITemplateCompiler[]
  ) {
    this.compilers = templateCompilers.reduce(
      (acc, item) => {
        acc[item.name] = item;
        return acc;
      },
      Object.create(null)
    );
  }

  public getElementTemplate(definition: TemplateDefinition, componentType?: ICustomElementType): ITemplate {
    if (!definition) {
      return null;
    }

    let found = this.templateLookup.get(definition);

    if (!found) {
      found = this.templateFromSource(definition);

      //If the element has a view, support Recursive Components by adding self to own view template container.
      if (found.renderContext !== null && componentType) {
        componentType.register(<ExposedContext>found.renderContext);
      }

      this.templateLookup.set(definition, found);
    }

    return found;
  }

  public getViewFactory(definition: Immutable<ITemplateDefinition>, parentContext?: IRenderContext): IViewFactory {
    if (!definition) {
      return null;
    }

    let factory = this.factoryLookup.get(definition);

    if (!factory) {
      const validSource = buildTemplateDefinition(null, definition)
      const template = this.templateFromSource(validSource, parentContext);
      factory = new ViewFactory(validSource.name, template);
      factory.setCacheSize(validSource.cache, true);
      this.factoryLookup.set(definition, factory);
    }

    return factory;
  }

  public applyRuntimeBehavior(Type: ICustomAttributeType | ICustomElementType, instance: ICustomAttribute | ICustomElement): void {
    let found = this.behaviorLookup.get(Type);

    if (!found) {
      found = RuntimeBehavior.create(Type, instance);
      this.behaviorLookup.set(Type, found);
    }

    found.applyTo(instance, this.changeSet);
  }

  public createRenderer(context: IRenderContext): IRenderer {
    return new Renderer(
      context,
      this.observerLocator,
      this.eventManager,
      this.parser,
      this
    );
  }

  private templateFromSource(definition: TemplateDefinition, parentContext?: IRenderContext): ITemplate {
    parentContext = parentContext || <ExposedContext>this.container;

    if (definition && definition.template) {
      if (definition.build.required) {
        const compilerName = definition.build.compiler || defaultCompilerName;
        const compiler = this.compilers[compilerName];

        if (!compiler) {
          throw Reporter.error(20, compilerName);
        }

        definition = compiler.compile(<ITemplateDefinition>definition, new RuntimeCompilationResources(<ExposedContext>parentContext), ViewCompileFlags.surrogate);
      }

      return new CompiledTemplate(this, parentContext, definition);
    }

    return noViewTemplate;
  }
}

/*@internal*/
export class RuntimeCompilationResources implements IResourceDescriptions {
  constructor(private context: ExposedContext) {}

  public find<TSource>(kind: IResourceKind<TSource>, name: string): ResourceDescription<TSource> | null {
    const key = kind.keyFrom(name);
    const resolver = this.context.getResolver<TSource>(key, false);

    if (resolver !== null && resolver.getFactory) {
      const factory = resolver.getFactory(this.context);

      if (factory !== null) {
        return (factory.type as IResourceType<TSource>).description || null;
      }
    }

    return null;
  }

  public create<TSource, TType extends IResourceType<TSource>>(kind: IResourceKind<TSource, TType>, name: string): InstanceType<TType> | null {
    const key = kind.keyFrom(name);
    if (this.context.has(key, false)) {
      return this.context.get<any>(key) || null;
    }
    return null;
  }
}

// The basic template abstraction that allows consumers to create
// instances of an INodeSequence on-demand. Templates are contextual in that they are, in the very least,
// part of a particular application, with application-level resources, but they also may have their
// own scoped resources or be part of another view (via a template controller) which provides a
// context for the template.
export interface ITemplate {
  readonly renderContext: IRenderContext;
  render(renderable: IRenderable, host?: INode, parts?: TemplatePartDefinitions): void;
}

// This is the main implementation of ITemplate.
// It is used to create instances of IView based on a compiled TemplateDefinition.
// TemplateDefinitions are hand-coded today, but will ultimately be the output of the
// TemplateCompiler either through a JIT or AOT process.
// Essentially, CompiledTemplate wraps up the small bit of code that is needed to take a TemplateDefinition
// and create instances of it on demand.
/*@internal*/
export class CompiledTemplate implements ITemplate {
  public readonly factory: INodeSequenceFactory;
  public readonly renderContext: IRenderContext;

  constructor(renderingEngine: IRenderingEngine, parentRenderContext: IRenderContext, private templateDefinition: TemplateDefinition) {
    this.factory = NodeSequenceFactory.createFor(templateDefinition.template);
    this.renderContext = createRenderContext(renderingEngine, parentRenderContext, templateDefinition.dependencies);
  }

  public render(renderable: IRenderable, host?: INode, parts?: TemplatePartDefinitions): void {
    const nodes = (<Writable<IRenderable>>renderable).$nodes = this.factory.createNodeSequence();
    (<Writable<IRenderable>>renderable).$context = this.renderContext;
    this.renderContext.render(renderable, nodes.findTargets(), this.templateDefinition, host, parts);
  }
}

// This is an implementation of ITemplate that always returns a node sequence representing "no DOM" to render.
/*@internal*/
export const noViewTemplate: ITemplate = {
  renderContext: null,
  render(renderable: IRenderable): void {
    (<Writable<IRenderable>>renderable).$nodes = NodeSequence.empty;
    (<Writable<IRenderable>>renderable).$context = null;
  }
};

export interface IRenderContext extends IServiceLocator {
  createChild(): IRenderContext;
  render(renderable: IRenderable, targets: ArrayLike<INode>, templateDefinition: TemplateDefinition, host?: INode, parts?: TemplatePartDefinitions): void;
  beginComponentOperation(renderable: IRenderable, target: INode, instruction: Immutable<ITargetedInstruction>, factory?: IViewFactory, parts?: TemplatePartDefinitions, location?: IRenderLocation, locationIsContainer?: boolean): IDisposable;
}

/*@internal*/
export type ExposedContext = IRenderContext & IDisposable & IContainer;

export function createRenderContext(renderingEngine: IRenderingEngine, parentRenderContext: IRenderContext, dependencies: ImmutableArray<any>): IRenderContext {
  const context = <ExposedContext>parentRenderContext.createChild();
  const renderableProvider = new InstanceProvider();
  const elementProvider = new InstanceProvider();
  const instructionProvider = new InstanceProvider<ITargetedInstruction>();
  const factoryProvider = new ViewFactoryProvider(renderingEngine);
  const renderLocationProvider = new InstanceProvider<IRenderLocation>();
  const renderer = renderingEngine.createRenderer(context);

  DOM.registerElementResolver(context, elementProvider);

  context.registerResolver(IViewFactory, factoryProvider);
  context.registerResolver(IRenderable, renderableProvider);
  context.registerResolver(ITargetedInstruction, instructionProvider);
  context.registerResolver(IRenderLocation, renderLocationProvider);

  if (dependencies) {
    context.register(...dependencies);
  }

  context.render = function(renderable: IRenderable, targets: ArrayLike<INode>, templateDefinition: TemplateDefinition, host?: INode, parts?: TemplatePartDefinitions): void {
    renderer.render(renderable, targets, templateDefinition, host, parts);
  };

  context.beginComponentOperation = function(renderable: IRenderable, target: INode, instruction: ITargetedInstruction, factory?: IViewFactory, parts?: TemplatePartDefinitions, location?: IRenderLocation): IDisposable {
    renderableProvider.prepare(renderable);
    elementProvider.prepare(target);
    instructionProvider.prepare(instruction);

    if (factory) {
      factoryProvider.prepare(factory, parts);
    }

    if (location) {
      renderLocationProvider.prepare(location);
    }

    return context;
  };

  context.dispose = function(): void {
    factoryProvider.dispose();
    renderableProvider.dispose();
    instructionProvider.dispose();
    elementProvider.dispose();
    renderLocationProvider.dispose();
  };

  return context;
}

/*@internal*/
export class InstanceProvider<T> implements IResolver {
  private instance: T = null;

  public prepare(instance: T): void {
    this.instance = instance;
  }

  public resolve(handler: IContainer, requestor: IContainer): T {
    if (this.instance === undefined) { // unmet precondition: call prepare
      throw Reporter.error(50); // TODO: organize error codes
    }
    return this.instance;
  }

  public dispose(): void {
    this.instance = null;
  }
}

/*@internal*/
export class ViewFactoryProvider implements IResolver {
  private factory: IViewFactory;
  private replacements: TemplatePartDefinitions;

  constructor(private renderingEngine: IRenderingEngine) {}

  public prepare(factory: IViewFactory, parts: TemplatePartDefinitions): void {
    this.factory = factory;
    this.replacements = parts || PLATFORM.emptyObject;
  }

  public resolve(handler: IContainer, requestor: ExposedContext): IViewFactory {
    const factory = this.factory;
    if (factory === undefined) { // unmet precondition: call prepare
      throw Reporter.error(50); // TODO: organize error codes
    }
    if (!factory.name || !factory.name.length) { // unmet invariant: factory must have a name
      throw Reporter.error(51); // TODO: organize error codes
    }
    const found = this.replacements[factory.name];
    if (found) {
      return this.renderingEngine.getViewFactory(found, requestor);
    }

    return this.factory;
  }

  public dispose(): void {
    this.factory = null;
    this.replacements = null;
  }
}

export const IRenderable = DI.createInterface<IRenderable>().noDefault();

export interface IBindables {
  /**
   * The Bindings, Views, CustomElements, CustomAttributes and other bindable components that belong to this instance.
   */
  $bindableHead?: IBindScope;
  $bindableTail?: IBindScope;
}

export interface IAttachables {

  /**
   * The Views, CustomElements, CustomAttributes and other attachable components that belong to this instance.
   */
  $attachableHead?: IAttach;
  $attachableTail?: IAttach;
}

/**
 * An object containing the necessary information to render something for display.
 */
export interface IRenderable extends IBindables, IAttachables, ILifecycleState {

  /**
   * The (dependency) context of this instance.
   *
   * Contains any dependencies required by this instance or its children.
   */
  readonly $context: IRenderContext;

  /**
   * The nodes that represent the visible aspect of this instance.
   *
   * Typically this will be a sequence of `DOM` nodes contained in a `DocumentFragment`
   */
  readonly $nodes: INodeSequence;

  /**
   * The binding scope that the `$bindables` of this instance will be bound to.
   *
   * This includes the `BindingContext` which can be either a user-defined view model instance, or a synthetic view model instantiated by a `templateController`
   */
  readonly $scope: IScope;
}

export function addBindable(renderable: IBindables, bindable: IBindScope): void {
  bindable.$prevBind = renderable.$bindableTail;
  bindable.$nextBind = null;
  if (renderable.$bindableTail === null) {
    renderable.$bindableHead = bindable;
  } else {
    renderable.$bindableTail.$nextBind = bindable;
  }
  renderable.$bindableTail = bindable;
}

export function addAttachable(renderable: IAttachables, attachable: IAttach): void {
  attachable.$prevAttach = renderable.$attachableTail;
  attachable.$nextAttach = null;
  if (renderable.$attachableTail === null) {
    renderable.$attachableHead = attachable;
  } else {
    renderable.$attachableTail.$nextAttach = attachable;
  }
  renderable.$attachableTail = attachable;
}
