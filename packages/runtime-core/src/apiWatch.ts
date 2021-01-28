import {
  effect,
  stop,
  isRef,
  Ref,
  ComputedRef,
  ReactiveEffectOptions,
  isReactive
} from '@vue/reactivity'
import { SchedulerJob, queuePreFlushCb } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged,
  NOOP,
  remove,
  isMap,
  isSet
} from '@vue/shared'
import {
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  recordInstanceBoundEffect
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'

export type WatchEffect = (onInvalidate: InvalidateCbRegistrator) => void

export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onInvalidate: InvalidateCbRegistrator
) => any

type MapSources<T> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? V
    : T[K] extends object ? T[K] : never
}

type MapOldSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true ? (V | undefined) : V
    : T[K] extends object
      ? Immediate extends true ? (T[K] | undefined) : T[K]
      : never
}

type InvalidateCbRegistrator = (cb: () => void) => void

export interface WatchOptionsBase {
  flush?: 'pre' | 'post' | 'sync'
  onTrack?: ReactiveEffectOptions['onTrack']
  onTrigger?: ReactiveEffectOptions['onTrigger']
}

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate
  deep?: boolean
}

export type WatchStopHandle = () => void

// Simple effect.
// 执行doWatch，将函数和选项传过去
export function watchEffect(
  effect: WatchEffect,
  options?: WatchOptionsBase // immediate deep flush onTrack onTrigger
): WatchStopHandle {
  return doWatch(effect, null, options)
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

// overload #1: array of multiple sources + cb
// Readonly constraint helps the callback to correctly infer value types based
// on position in the source array. Otherwise the values will get a union type
// of all possible value types.
export function watch<
  T extends Readonly<Array<WatchSource<unknown> | object>>,
  Immediate extends Readonly<boolean> = false
>(
  sources: T,
  cb: WatchCallback<MapSources<T>, MapOldSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload #2: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? (T | undefined) : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload #3: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? (T | undefined) : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// implementation
// 执行doWatch，将函数，cb和选项传过去
export function watch<T = any>(
  source: WatchSource<T> | WatchSource<T>[],
  cb: WatchCallback<T>,
  options?: WatchOptions
): WatchStopHandle {
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source, cb, options)
}

function doWatch(
  source: WatchSource | WatchSource[] | WatchEffect,
  cb: WatchCallback | null,
  { immediate, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ,
  instance = currentInstance
): WatchStopHandle {
  if (__DEV__ && !cb) {
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }

  const warnInvalidSource = (s: unknown) => {
    warn(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`
    )
  }

  let getter: () => any
  // 判断是否ref
  // watchEffect 传进来的source是一个函数不会是ref
  const isRefSource = isRef(source)
  if (isRefSource) {
    getter = () => (source as Ref).value
  } else if (isReactive(source)) {
    getter = () => source
    deep = true
  } else if (isArray(source)) {
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return traverse(s)
        } else if (isFunction(s)) {
          return callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER)
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    // watch source是函数，也会执行到这里
    // watchEffect 会执行到这里，watchEffect 没有callback，对于 watchEffect 传的函数既是 getter 又是 callback
    if (cb) {
      // getter with cb
      // 赋值getter
      getter = () =>
        // 执行函数并错误处理
        callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)
    } else {
      // no cb -> simple effect
      // watchEffect 会执行到这里
      // 赋值getter：主要是执行source函数
      getter = () => {
        // 判断当前组件是否卸载
        if (instance && instance.isUnmounted) {
          // 在setup中的watchEffect第一次执行时instance已经创建，但此时还没有渲染组件也没有卸载组件，直接返回
          return
        }
        if (cleanup) {
          cleanup()
        }
        // 执行函数并错误处理（try catch）
        return callWithErrorHandling(
          source,
          instance,
          // 给不同的 effect getter 调用时会定义不同的 ErrorCodes，用来标识错误，快速定位
          ErrorCodes.WATCH_CALLBACK,
          // 处理函数数组
          [onInvalidate]
        )
      }
    }
  } else {
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  // watch时传了callback和deep时，getter的赋值
  if (cb && deep) {
    // 保存之前的getter
    const baseGetter = getter
    // 赋值getter
    // traverse：遍历baseGetter的返回值
    getter = () => traverse(baseGetter())
  }

  // 声明cleanup
  let cleanup: () => void
  // 声明onInvalidate：处理不正确的函数
  const onInvalidate: InvalidateCbRegistrator = (fn: () => void) => {
    cleanup = runner.options.onStop = () => {
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
    }
  }

  // in SSR there is no need to setup an actual effect, and it should be noop
  // unless it's eager
  // ssr
  if (__NODE_JS__ && isInSSRComponentSetup) {
    if (!cb) {
      getter()
    } else if (immediate) {
      callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
        getter(),
        undefined,
        onInvalidate
      ])
    }
    return NOOP
  }

  // 赋值oldValue，source是数组时赋值为[]，否者赋值为初始化空对象
  let oldValue = isArray(source) ? [] : INITIAL_WATCHER_VALUE
  // 声明job函数：执行runner和cb
  const job: SchedulerJob = () => {
    if (!runner.active) {
      return
    }
    if (cb) {
      // watch(source, cb)
      // runner就是传入的函数包装的effect
      // 执行runner
      const newValue = runner()
      if (deep || isRefSource || hasChanged(newValue, oldValue)) {
        // cleanup before running cb again
        // 在第二次runner之前cleanup
        if (cleanup) {
          cleanup()
        }
        // 执行cb
        callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
          newValue,
          // pass undefined as the old value when it's changed for the first time
          oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
          onInvalidate
        ])
        // 赋值oldValue
        oldValue = newValue
      }
    } else {
      // watchEffect
      runner()
    }
  }

  // important: mark the job as a watcher callback so that scheduler knows it
  // it is allowed to self-trigger (#1727)
  job.allowRecurse = !!cb

  // 声明scheduler：实际上是包装了job
  let scheduler: (job: () => any) => void
  // 赋值scheduler
  // flush指定什么时候执行函数：sync post pre，相对于render函数来说，默认pre
  if (flush === 'sync') {
    // 同步的
    scheduler = job
  } else if (flush === 'post') {
    // 延后的
    // queuePostRenderEffect：调度流程
    scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
  } else {
    // default: 'pre'
    // 默认pre
    // 之前的
    scheduler = () => {
      // 实例不存在或已经被挂载
      if (!instance || instance.isMounted) {
        queuePreFlushCb(job)
      } else {
        // with 'pre' option, the first call must happen before
        // the component is mounted so it is called synchronously.
        // pre时，第一次调用必须在组件挂载之前，所以是同步的
        job()
      }
    }
  }

  // 声明runner：effect包装过的getter，过程中会执行getter
  const runner = effect(getter, {
    lazy: true,
    onTrack,
    onTrigger,
    scheduler
  })

  // 记录组件实例上面所有的Effect
  recordInstanceBoundEffect(runner)

  // initial run
  // 初次调用，即声明时调用的doWatch
  if (cb) {
    if (immediate) {
      // immediate：立即执行job，job中执行了callback
      job()
    } else {
      // oldValue：执行下一次runner前的值，watch的cb中的旧值就是这个
      oldValue = runner()
    }
  } else if (flush === 'post') {
    queuePostRenderEffect(runner, instance && instance.suspense)
  } else {
    // 执行runner
    // 对应到watchEffect就是立即执行传入的函数
    runner()
  }

  // 返回一个关闭watch的函数
  return () => {
    stop(runner)
    if (instance) {
      remove(instance.effects!, runner)
    }
  }
}

// this.$watch
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  cb: Function,
  options?: WatchOptions
): WatchStopHandle {
  const publicThis = this.proxy as any
  const getter = isString(source)
    ? () => publicThis[source]
    : source.bind(publicThis)
  return doWatch(getter, cb.bind(publicThis), options, this)
}

function traverse(value: unknown, seen: Set<unknown> = new Set()) {
  if (!isObject(value) || seen.has(value)) {
    return value
  }
  seen.add(value)
  if (isRef(value)) {
    traverse(value.value, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (isMap(value)) {
    value.forEach((_, key) => {
      // to register mutation dep for existing keys
      traverse(value.get(key), seen)
    })
  } else if (isSet(value)) {
    value.forEach(v => {
      traverse(v, seen)
    })
  } else {
    for (const key in value) {
      traverse(value[key], seen)
    }
  }
  return value
}
