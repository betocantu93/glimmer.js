import { assert } from '@glimmer/util';
import { reifyPositional } from '@glimmer/runtime';
import { Helper as VMHelperFactory, CapturedArguments, VM } from '@glimmer/interfaces';
import { createComputeRef, valueForRef, Reference } from '@glimmer/reference';
import { DEBUG } from '@glimmer/env';
import { TemplateArgs } from '../interfaces';
import { argsProxyFor } from './util';
import { OWNER_KEY } from '../owner';
import { getHelperManager } from '.';
import { unbindableFunction } from '../utils/unbindable-function';
import { trackedMemoize } from '../utils/autotracking';

///////////

export interface Capabilities {
  destroyable: boolean;
  updateHook: boolean;
}

export type OptionalCapabilities = Partial<Capabilities>;

export type ManagerAPIVersion = 'glimmerjs-2.0.0';

export function capabilities(
  managerAPI: ManagerAPIVersion,
  options: OptionalCapabilities = {}
): Capabilities {
  assert(managerAPI === 'glimmerjs-2.0.0', 'Invalid helper manager compatibility specified');

  return {
    destroyable: Boolean(options.destroyable),
    updateHook: Boolean(options.updateHook),
  };
}

///////////

export type HelperDefinition<_HelperStateBucket = unknown> = {};

export interface HelperManager<HelperStateBucket> {
  capabilities: Capabilities;

  getValue(bucket: HelperStateBucket): unknown;
  createHelper(
    definition: HelperDefinition<HelperStateBucket>,
    args: TemplateArgs
  ): HelperStateBucket;
}

export function hasUpdateHook<HelperStateBucket>(
  delegate: HelperManager<HelperStateBucket>
): delegate is HelperManagerWithUpdateHook<HelperStateBucket> {
  return delegate.capabilities.updateHook;
}

export interface HelperManagerWithUpdateHook<HelperStateBucket>
  extends HelperManager<HelperStateBucket> {
  updateHelper(bucket: HelperStateBucket, args: TemplateArgs): void;
}

export function hasDestroyable<HelperStateBucket>(
  delegate: HelperManager<HelperStateBucket>
): delegate is HelperManagerWithDestroyable<HelperStateBucket> {
  return delegate.capabilities.destroyable;
}

export interface HelperManagerWithDestroyable<HelperStateBucket>
  extends HelperManager<HelperStateBucket> {
  getDestroyable(bucket: HelperStateBucket): object;
}

///////////

function customHelperFn<T>(
  manager: HelperManager<T>,
  definition: HelperDefinition<T>,
  capturedArgs: CapturedArguments,
  vm: VM
): () => unknown {
  let bucket: undefined | T;

  const argsProxy = argsProxyFor(capturedArgs, 'helper');
  const hasUpdate = hasUpdateHook(manager);

  const getValue = trackedMemoize(() => manager.getValue(bucket!));

  const createOrUpdate = trackedMemoize(() => {
    if (bucket === undefined) {
      bucket = manager.createHelper(definition, argsProxy);

      if (hasDestroyable(manager)) {
        vm.associateDestroyable(manager.getDestroyable(bucket));
      }
    } else if (hasUpdate) {
      (manager as HelperManagerWithUpdateHook<T>).updateHelper(bucket!, argsProxy);
    }
  });

  return (): unknown => {
    createOrUpdate();
    return getValue();
  };
}

export type SimpleHelper<T = unknown, U = unknown> = (...args: T[]) => U;

/**
 * Returns a factory that produces a HelperRootReference, which is how the VM
 * expects to receive helpers currently.
 *
 * @param definition the helper definition
 */
export function vmHelperFactoryFor<HelperStateBucket>(
  definition: HelperDefinition<HelperStateBucket>
): VMHelperFactory {
  return (args, vm): Reference => {
    const owner = valueForRef(vm.dynamicScope().get(OWNER_KEY)) as object;
    const manager = getHelperManager(owner, definition)!;
    const capturedArgs = args.capture();

    let helperFn: (capturedArgs: CapturedArguments) => unknown;

    if (manager !== undefined) {
      helperFn = customHelperFn(manager, definition, capturedArgs, vm);
    } else {
      if (DEBUG) {
        assert(
          typeof definition === 'function',
          `Attempted to use ${definition} as a helper, but it was not a function and did not have an associated helper manager. Helpers must either be plain JavaScript functions, or managed with a helper manager.`
        );
      }

      const func = DEBUG
        ? unbindableFunction!(definition as SimpleHelper)
        : (definition as SimpleHelper);

      helperFn = (capturedArgs: CapturedArguments): unknown => {
        if (DEBUG && Object.keys(capturedArgs.named).length > 0) {
          throw new Error(
            `You used named arguments with the ${func.name.replace(
              /^bound /,
              ''
            )} helper, but it is a standard function. Normal functions cannot receive named arguments when used as helpers.`
          );
        }

        return func(...reifyPositional(capturedArgs.positional));
      };
    }

    return createComputeRef(() => helperFn(capturedArgs), null, helperFn.name);
  };
}
