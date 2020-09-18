import { BaseApplication, Loader, Renderer, INTERNAL_DYNAMIC_SCOPE } from '@glimmer/application';
import { Resolver, Dict } from '@glimmer/di';
import { PathReference, RootReference } from '@glimmer/reference';
import { DefaultDynamicScope } from '@glimmer/runtime';

import { PassThrough } from 'stream';
import createHTMLDocument from '@simple-dom/document';
import HTMLSerializer from '@simple-dom/serializer';
import voidMap from '@simple-dom/void-map';

import EnvironmentImpl from './environment';
import StringBuilder from './string-builder';

export interface SSRApplicationOptions {
  rootName: string;
  resolver: Resolver;
  loader: Loader;
  renderer: Renderer;
  serializer?: HTMLSerializer;
  [INTERNAL_DYNAMIC_SCOPE]?: Dict<unknown>;
}

/**
 * Converts a POJO into a dictionary of references that can be passed as an argument to render a component.
 */
function convertOpaqueToReferenceDict(data: Dict<unknown>): Dict<PathReference<unknown>> {
  if (!data) {
    return {};
  }

  return Object.keys(data).reduce((acc, key) => {
    acc[key] = new RootReference(data[key]);
    return acc;
  }, {});
}

// TODO: Move out container setup out of here so that we can reuse the same application instance / registry across requests.
export default class Application extends BaseApplication {
  protected serializer: HTMLSerializer;

  constructor({ rootName, resolver, loader, renderer, serializer }: SSRApplicationOptions) {
    super({
      rootName,
      resolver,
      loader,
      renderer,
      environment: EnvironmentImpl,
    });

    this.serializer = serializer || new HTMLSerializer(voidMap);

    // Setup registry and DI
    this.initialize();
  }

  static async renderToStream(
    componentName: string,
    data: Dict<unknown>,
    stream: NodeJS.WritableStream,
    options: SSRApplicationOptions
  ) {
    const app = new Application(options);
    try {
      const env = app.lookup(`environment:/${app.rootName}/main/main`);
      const element = createHTMLDocument().body;

      const builder = new StringBuilder({ element }).getBuilder(env);

      const templateIterator = await app.loader.getComponentTemplateIterator(
        app,
        env,
        builder,
        componentName,
        convertOpaqueToReferenceDict(data),
        new DefaultDynamicScope(convertOpaqueToReferenceDict(options[INTERNAL_DYNAMIC_SCOPE]))
      );

      env.begin();
      await app.renderer.render(templateIterator);
      env.commit();
      stream.write(app.serializer.serializeChildren(element));
      stream.end();
    } catch (err) {
      stream.emit('error', err);
    }
  }

  static async renderToString(
    componentName: string,
    data: Dict<unknown>,
    options: SSRApplicationOptions
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const stream = new PassThrough();
      let html = '';

      stream.on('data', str => (html += str));
      stream.on('end', () => resolve(html));
      stream.on('error', err => reject(err));

      this.renderToStream(componentName, data, stream, options);
    });
  }
}