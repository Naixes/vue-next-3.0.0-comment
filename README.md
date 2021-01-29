# vue-next-3.0.0-comment

### 响应式原理

#### reactive函数

```ts
// reactive函数：实质创建的是一个对应对象对应类型的proxy对象
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  // 判断是否已经被readonly api处理过，处理过直接返回
  if (target && (target as Target)[ReactiveFlags.IS_READONLY]) {
    return target
  }
  // 创建响应式对象，实际创建的是一个对应对象对应类型的proxy对象
  // reactive，shallowReactive，readonly都会使用这个函数创建对象，最大的区别就是处理函数不一样
  return createReactiveObject(
    target,
    false,
    // proxy需要接收的一些处理函数
    mutableHandlers,
    mutableCollectionHandlers
  )
}
...
function createReactiveObject(
  target: Target,
  isReadonly: boolean,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>
) {
  // target只接受对象，因为要进行代理
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // target is already a Proxy, return it.
  // exception: calling readonly() on a reactive object
  if (
    // ReactiveFlags.RAW：标记对象是否已经是一个响应式对象（Proxy），是的话直接返回
    // 例外：调用这个函数的函数是readonly并且target是响应式对象
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  // target already has corresponding Proxy
  // readonlyMap和reactiveMap是weakmap，用来存储所有响应式对象
  const proxyMap = isReadonly ? readonlyMap : reactiveMap
  // 判断是否已经存在这个响应式对象，存在直接返回
  // 当多次响应化同一个对象时，后面会直接返回第一次生成的对象
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }
  // only a whitelist of value types can be observed.
  // 获取判断和归类后的类型，返回INVALID时直接返回
  const targetType = getTargetType(target)
  if (targetType === TargetType.INVALID) {
    return target
  }
  const proxy = new Proxy(
    target,
    // 根据不同的归类类型使用不同的处理函数
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers
  )
  // 存储生成好的代理对象
  proxyMap.set(target, proxy)
  return proxy
}
...
// 将原生类型进行归类：COMMON，COLLECTION，INVALID
function targetTypeMap(rawType: string) {
  switch (rawType) {
    case 'Object':
    case 'Array':
      return TargetType.COMMON
    case 'Map':
    case 'Set':
    case 'WeakMap':
    case 'WeakSet':
      return TargetType.COLLECTION
    default:
      return TargetType.INVALID
  }
}
```

#### proxy的dandler

##### mutableHandlers

```ts
// reative函数传入的Handlers
export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}
```

- get

  ```ts
  // 获取不同的get函数
  const get = /*#__PURE__*/ createGetter()
  const shallowGet = /*#__PURE__*/ createGetter(false, true)
  const readonlyGet = /*#__PURE__*/ createGetter(true)
  const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)
  
  const arrayInstrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  // 对于'includes', 'indexOf', 'lastIndexOf'会增加一些特殊操作
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    const method = Array.prototype[key] as any
    arrayInstrumentations[key] = function(this: unknown[], ...args: unknown[]) {
      const arr = toRaw(this)
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      const res = method.apply(arr, args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return method.apply(arr, args.map(toRaw))
      } else {
        return res
      }
    }
  })
  
  // 返回get函数
  function createGetter(isReadonly = false, shallow = false) {
    // 例如执行arr.indexOf() target就是arr indexOf就是key receiver就是proxy对象
    return function get(target: Target, key: string | symbol, receiver: object) {
      // 判断key
      if (key === ReactiveFlags.IS_REACTIVE) {
        return !isReadonly
      } else if (key === ReactiveFlags.IS_READONLY) {
        return isReadonly
      } else if (
        key === ReactiveFlags.RAW &&
        // 判断是否已经存储到过对应的map中
        receiver === (isReadonly ? readonlyMap : reactiveMap).get(target)
      ) {
        return target
      }
  
      const targetIsArray = isArray(target)
      // target是数组 并且key是通过arrayInstrumentations处理过的特殊方法
      if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
        // 从arrayInstrumentations中获取这些方法
        return Reflect.get(arrayInstrumentations, key, receiver)
      }
  
      // 普通的属性或方法直接从target中获取
      const res = Reflect.get(target, key, receiver)
  
      const keyIsSymbol = isSymbol(key)
      if (
        // key是symbol 并且是内置symbol 或者
        // key是__proto__或__v_isRef
        // 是的话直接返回 一般符合这些条件的不是我们主动调用的 而是再调用属性或者方法时自动调用的 不需要跟踪
        keyIsSymbol
          ? builtInSymbols.has(key as symbol)
          : key === `__proto__` || key === `__v_isRef`
      ) {
        return res
      }
  
      // 非readonly
      if (!isReadonly) {
        // 比如render渲染<div>{state.name}</div>这个的时候会调用state.name
        // 说明现在调用的这个操作(render)是依赖于对象(state)上的key(name)的
        // 执行完track之后state.name如果发生变化render函数是会被重新调用的
        // TrackOpTypes指操作类型: GET HAS ITERATE
        track(target, TrackOpTypes.GET, key)
      }
  
      // shallow直接返回，否者后面会进行ref的包装和object包装（主要是子内容的响应化）
      // 如果不希望对象被放到reactive对象里时被转换成reactive时使用
      // 有一些第三方的类库提供的对象是不支持reactive不能被包装成reactive的，包装后会有问题
      if (shallow) {
        return res
      }
  
      // 值为ref
      if (isRef(res)) {
        // ref unwrapping - does not apply for Array + integer key.
        // 判断返回ref还是返回value 这里会造成一定的感念混淆
        // 不是数组或者不是数字的key直接返回value 简单来说就是非数组或非数组操作
        const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
        return shouldUnwrap ? res.value : res
      }
  
      // 值为obj
      if (isObject(res)) {
        // Convert returned value into a proxy as well. we do the isObject check
        // here to avoid invalid value warning. Also need to lazy access readonly
        // and reactive here to avoid circular dependency.
        // 包裹readonly或者响应化该对象
        // 在获取的对象子内容也是对象时会将它也响应化(proxy)
        return isReadonly ? readonly(res) : reactive(res)
      }
  
      return res
    }
  }
  ```

- set

  ```ts
  // 获取不同的set函数 shallow
  const set = /*#__PURE__*/ createSetter()
  const shallowSet = /*#__PURE__*/ createSetter(true)
  
  function createSetter(shallow = false) {
    return function set(
      target: object,
      key: string | symbol,
      value: unknown,
      receiver: object
    ): boolean {
      const oldValue = (target as any)[key]
      // 非shallow指返回的对象仍然是一个响应式对象
      if (!shallow) {
        value = toRaw(value)
        // 对象不是数组并且旧值是ref但是新值不是ref 则认为是修改ref的value而不是修改整个ref
        if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
          oldValue.value = value
          return true
        }
      } else {
        // in shallow mode, objects are set as-is regardless of reactive or not
      }
  
      // 判断key是否存在 存在SET 不存在 ADD
      const hadKey =
        // 数组并为key为数字
        isArray(target) && isIntegerKey(key)
          ? Number(key) < target.length
          : hasOwn(target, key)
      // 设置新值
      const result = Reflect.set(target, key, value, receiver)
      // don't trigger if target is something up in the prototype chain of original
      // 例如const state = reactive({name: ref('naixes')}); toRaw(receiver)就是{name: ref('naixes')} receiver(proxy)就是state
      // 判断target是否和proxy代理的对象是同一对象，是同一对象时trigger跟踪了这个属性的函数
      if (target === toRaw(receiver)) {
        if (!hadKey) {
          // 不存在的key
          // TriggerOpTypes: SET ADD DELETE CLEAR
          // trigger：trigger跟踪了这个属性的函数
          trigger(target, TriggerOpTypes.ADD, key, value)
        } else if (hasChanged(value, oldValue)) {
          // 存在并且新值不等于旧值
          trigger(target, TriggerOpTypes.SET, key, value, oldValue)
        }
      }
      return result
    }
  }
  ```

- 其他

  ```ts
  function deleteProperty(target: object, key: string | symbol): boolean {
    const hadKey = hasOwn(target, key)
    const oldValue = (target as any)[key]
    // 执行删除，返回Boolean
    const result = Reflect.deleteProperty(target, key)
    if (result && hadKey) {
      // 删除成功并且key存在，trigger跟踪了这个属性的函数
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }
  
  function has(target: object, key: string | symbol): boolean {
    // 执行判断
    const result = Reflect.has(target, key)
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      // key不是symbol或者不是内置symbol时执行跟踪，key变化的话has也会变化也算是一种依赖关系
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }
  
  function ownKeys(target: object): (string | number | symbol)[] {
    track(target, TrackOpTypes.ITERATE, ITERATE_KEY)
    return Reflect.ownKeys(target)
  }
  
  // 和将get set改为了shallowGet shallowSet
  export const shallowReactiveHandlers: ProxyHandler<object> = extend(
    {},
    mutableHandlers,
    {
      get: shallowGet,
      set: shallowSet
    }
  )
  ```

##### mutableCollectionHandlers

```ts
// reative函数传入的CollectionHandlers
export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  // 只有get，因为使用map操作时都是执行map.xxx，作为map的代理这些操作都会触发get方法所以只需要get方法就可以了
  get: createInstrumentationGetter(false, false)
}

function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  // 判断shallow和readonly
  const instrumentations = shallow
    ? shallowInstrumentations
    : isReadonly
      ? readonlyInstrumentations
      : mutableInstrumentations

  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes
  ) => {
    // 特殊key的读取
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.RAW) {
      return target
    }

    return Reflect.get(
      // 判断instrumentations是否有key
      hasOwn(instrumentations, key) && key in target
        // 有的话被instrumentations代理
        ? instrumentations
        // 没有的话才从target上面获取
        : target,
      key,
      receiver
    )
  }
}

const mutableInstrumentations: Record<string, Function> = {
  get(this: MapTypes, key: unknown) {
    return get(this, key)
  },
  get size() {
    return size((this as unknown) as IterableCollections)
  },
  has,
  add,
  set,
  delete: deleteEntry,
  clear,
  forEach: createForEach(false, false)
}

// 返回值
function get(
  target: MapTypes,
  key: unknown,
  isReadonly = false,
  isShallow = false
) {
  // #1772: readonly(reactive(Map)) should return readonly + reactive version
  // of the value
  // 获取真正的对象非proxy
  target = (target as any)[ReactiveFlags.RAW]
  // 确保获得真正的对象和key
  const rawTarget = toRaw(target)
  const rawKey = toRaw(key)
  if (key !== rawKey) {
    // key和rawKey不一样，key是proxy，执行跟踪key
    !isReadonly && track(rawTarget, TrackOpTypes.GET, key)
  }
  // 执行跟踪rawKey
  !isReadonly && track(rawTarget, TrackOpTypes.GET, rawKey)
  // 获取map对象rawTarget的has，还有get，set等方法
  const { has } = getProto(rawTarget)
  // 返回toReadonly | toShallow | toReactive
  const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
  // 判断是否有值，有值获调用target的取值并进行相应的包装
  if (has.call(rawTarget, key)) {
    return wrap(target.get(key))
  } else if (has.call(rawTarget, rawKey)) {
    return wrap(target.get(rawKey))
  }
}

function has(this: CollectionTypes, key: unknown, isReadonly = false): boolean {
  // 获取到真正的值
  const target = (this as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  const rawKey = toRaw(key)
  // 执行跟踪key
  if (key !== rawKey) {
    !isReadonly && track(rawTarget, TrackOpTypes.HAS, key)
  }
  !isReadonly && track(rawTarget, TrackOpTypes.HAS, rawKey)
  // 调用target的has
  return key === rawKey
    ? target.has(key)
    : target.has(key) || target.has(rawKey)
}

function size(target: IterableCollections, isReadonly = false) {
  // 获取到真正的值
  target = (target as any)[ReactiveFlags.RAW]
  // 执行跟踪
  !isReadonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
  // 调用target的size
  return Reflect.get(target, 'size', target)
}

// this不是一个参数只是this的类型声明，编译后只有两个参数，ts特性
function set(this: MapTypes, key: unknown, value: unknown) {
  value = toRaw(value)
  // 这里会进入get，因为会触发获取属性__v_raw
  const target = toRaw(this)
  const { has, get } = getProto(target)

  // 判断key是否存在
  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    // 判断转换过row的key是否存在
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  // 获取旧值
  const oldValue = get.call(target, key)
  // 执行set
  const result = target.set(key, value)
  if (!hadKey) {
    // 执行trigger，没有就ADD
    trigger(target, TriggerOpTypes.ADD, key, value)
  } else if (hasChanged(value, oldValue)) {
    // 执行trigger，有就SET
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  return result
}
```

#### ref

见注释

#### computed

见注释

#### 过一遍watchEffect和watch

```ts
// Simple effect.
// 执行doWatch，将函数和选项传过去
export function watchEffect(
  effect: WatchEffect,
  options?: WatchOptionsBase // immediate deep flush onTrack onTrigger
): WatchStopHandle {
  return doWatch(effect, null, options)
}

// implementation
// 执行doWatch，将函数，cb和选项传过去
export function watch<T = any>(
  source: WatchSource<T> | WatchSource<T>[],
  cb: WatchCallback<T>,
  options?: WatchOptions
): WatchStopHandle {
  // 判断并提示警告信息
  ...
  return doWatch(source, cb, options)
}

function doWatch(
  source: WatchSource | WatchSource[] | WatchEffect,
  cb: WatchCallback | null,
  { immediate, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ,
  instance = currentInstance
): WatchStopHandle {
  // 判断并提示警告信息
  ...

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
      // 赋值getter
      getter = () => {
        // 判断当前组件是否卸载
        if (instance && instance.isUnmounted) {
          // 在setup中的watchEffect第一次执行时instance已经创建，但此时还没有渲染组件也没有卸载组件，直接返回
          return
        }
        if (cleanup) {
          cleanup()
        }
        // 执行函数并错误处理
        return callWithErrorHandling(
          source,
          instance,
          ErrorCodes.WATCH_CALLBACK,
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
  // 声明job函数
  const job: SchedulerJob = () => {
    if (!runner.active) {
      return
    }
    if (cb) {
      // watch(source, cb)
      // runner就是传入的函数包装的effect
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

  let scheduler: (job: () => any) => void
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

  // 声明runner
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
```



#### effect

##### track和trigger

##### trackStack的使用场景

```ts
// effect.ts
...
let shouldTrack = true
const trackStack: boolean[] = []

// 案例场景：
// setup(){
//   const state = reactive({
//     name: 'sin'
//   })
//   const name = state.name + '1'
//   ...
// }
// 如果setup中使用到了reactive的变量，但是setup只执行一次，为了避免setup也被加入到依赖重复执行，提供了函数pauseTracking中止tracking
// 在component render的时候会使用到
// runtime-core中的component.ts中的setupStatefulComponent函数，call setup()部分
// 流程如下：
// 默认shouldTrack = true
// 调用setup时pauseTracking，push了true，shouldTrack = false，即[true]
// 执行到watchEffect时enableTracking，push了false，shouldTrack = true，即[true, false]
// watchEffect执行完之后resetTracking，pop了false，shouldTrack = false（pop的值）
// 此时继续执行setup，shouldTrack也还是保持之前的false终止状态

// shouldTrack设为false
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

// shouldTrack设为true
export function enableTracking() {
  // trackStack中push，shouldTrack
  // shouldTrack全局变量，默认true
  trackStack.push(shouldTrack)
  shouldTrack = true
}

// pop出最后一个设为当前的值
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}
...
```

##### callWithErrorHandling及onInvalidate

##### scheduler

执行顺序

sync 在数据更新时同步执行

pre/watchEffect 取决于代码位置

render 渲染

post 在这里可以做html的更新

# vue-next

This is the repository for Vue 3.0.

## Quickstart

- Via CDN: `<script src="https://unpkg.com/vue@next"></script>`
- In-browser playground on [Codepen](https://codepen.io/yyx990803/pen/OJNoaZL)
- Scaffold via [Vite](https://github.com/vitejs/vite):

  ```bash
  npm init vite-app hello-vue3 # OR yarn create vite-app hello-vue3
  ```

- Scaffold via [vue-cli](https://cli.vuejs.org/):

  ```bash
  npm install -g @vue/cli # OR yarn global add @vue/cli
  vue create hello-vue3
  # select vue 3 preset
  ```

## Changes from Vue 2

Please consult the [Migration Guide](https://v3.vuejs.org/guide/migration/introduction.html).

- Note: IE11 support is still pending.

## Supporting Libraries

All of our official libraries and tools now support Vue 3, but most of them are still in beta status and distributed under the `next` dist tag on NPM. **We are planning to stabilize and switch all projects to use the `latest` dist tag by end of 2020.**

### Vue CLI

As of v4.5.0, `vue-cli` now provides built-in option to choose Vue 3 preset when creating a new project. You can upgrade `vue-cli` and run `vue create` to create a Vue 3 project today.

### Vue Router

Vue Router 4.0 provides Vue 3 support and has a number of breaking changes of its own. Check out its [Migration Guide](https://next.router.vuejs.org/guide/migration/) for full details.

- [![beta](https://img.shields.io/npm/v/vue-router/next.svg)](https://www.npmjs.com/package/vue-router/v/next)
- [Github](https://github.com/vuejs/vue-router-next)
- [RFCs](https://github.com/vuejs/rfcs/pulls?q=is%3Apr+is%3Amerged+label%3Arouter)

### Vuex

Vuex 4.0 provides Vue 3 support with largely the same API as 3.x. The only breaking change is [how the plugin is installed](https://github.com/vuejs/vuex/tree/4.0#breaking-changes).

- [![beta](https://img.shields.io/npm/v/vuex/next.svg)](https://www.npmjs.com/package/vuex/v/next)
- [Github](https://github.com/vuejs/vuex/tree/4.0)

### Devtools Extension

We are working on a new version of the Devtools with a new UI and refactored internals to support multiple Vue versions. The new version is currently in beta and only supports Vue 3 (for now). Vuex and Router integration is also work in progress.

- For Chrome: [Install from Chrome web store](https://chrome.google.com/webstore/detail/vuejs-devtools/ljjemllljcmogpfapbkkighbhhppjdbg?hl=en)

  - Note: the beta channel may conflict with the stable version of devtools so you may need to temporarily disable the stable version for the beta channel to work properly.

- For Firefox: [Download the signed extension](https://github.com/vuejs/vue-devtools/releases/tag/v6.0.0-beta.2) (`.xpi` file under Assets)

### IDE Support

It is recommended to use [VSCode](https://code.visualstudio.com/) with our official extension [Vetur](https://marketplace.visualstudio.com/items?itemName=octref.vetur), which provides comprehensive IDE support for Vue 3.

### Other Projects

| Project               | NPM                           | Repo                 |
| --------------------- | ----------------------------- | -------------------- |
| @vue/babel-plugin-jsx | [![rc][jsx-badge]][jsx-npm]   | [[Github][jsx-code]] |
| eslint-plugin-vue     | [![beta][epv-badge]][epv-npm] | [[Github][epv-code]] |
| @vue/test-utils       | [![beta][vtu-badge]][vtu-npm] | [[Github][vtu-code]] |
| vue-class-component   | [![beta][vcc-badge]][vcc-npm] | [[Github][vcc-code]] |
| vue-loader            | [![beta][vl-badge]][vl-npm]   | [[Github][vl-code]]  |
| rollup-plugin-vue     | [![beta][rpv-badge]][rpv-npm] | [[Github][rpv-code]] |

[jsx-badge]: https://img.shields.io/npm/v/@vue/babel-plugin-jsx.svg
[jsx-npm]: https://www.npmjs.com/package/@vue/babel-plugin-jsx
[jsx-code]: https://github.com/vuejs/jsx-next
[vd-badge]: https://img.shields.io/npm/v/@vue/devtools/beta.svg
[vd-npm]: https://www.npmjs.com/package/@vue/devtools/v/beta
[vd-code]: https://github.com/vuejs/vue-devtools/tree/next
[epv-badge]: https://img.shields.io/npm/v/eslint-plugin-vue/next.svg
[epv-npm]: https://www.npmjs.com/package/eslint-plugin-vue/v/next
[epv-code]: https://github.com/vuejs/eslint-plugin-vue
[vtu-badge]: https://img.shields.io/npm/v/@vue/test-utils/next.svg
[vtu-npm]: https://www.npmjs.com/package/@vue/test-utils/v/next
[vtu-code]: https://github.com/vuejs/vue-test-utils-next
[jsx-badge]: https://img.shields.io/npm/v/@ant-design-vue/babel-plugin-jsx.svg
[jsx-npm]: https://www.npmjs.com/package/@ant-design-vue/babel-plugin-jsx
[jsx-code]: https://github.com/vueComponent/jsx
[vcc-badge]: https://img.shields.io/npm/v/vue-class-component/next.svg
[vcc-npm]: https://www.npmjs.com/package/vue-class-component/v/next
[vcc-code]: https://github.com/vuejs/vue-class-component/tree/next
[vl-badge]: https://img.shields.io/npm/v/vue-loader/next.svg
[vl-npm]: https://www.npmjs.com/package/vue-loader/v/next
[vl-code]: https://github.com/vuejs/vue-loader/tree/next
[rpv-badge]: https://img.shields.io/npm/v/rollup-plugin-vue/next.svg
[rpv-npm]: https://www.npmjs.com/package/rollup-plugin-vue/v/next
[rpv-code]: https://github.com/vuejs/rollup-plugin-vue/tree/next
