import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  (): T
  _isEffect: true
  id: number
  active: boolean
  raw: () => T
  deps: Array<Dep>
  options: ReactiveEffectOptions
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  scheduler?: (job: ReactiveEffect) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
  allowRecurse?: boolean
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

const effectStack: ReactiveEffect[] = []
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

// effect：主要是createReactiveEffect创建effect
export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  // 是否已经是effect：利用_isEffect判断
  if (isEffect(fn)) {
    fn = fn.raw
  }
  const effect = createReactiveEffect(fn, options)
  // doWatch中runner用到的effect，lazy为true，所以effect不会立即执行
  if (!options.lazy) {
    effect()
  }
  return effect
}

export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

// 创建effect，effect是一个函数
function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(): unknown {
    // active在下面注入
    if (!effect.active) {
      // 直接执行fn
      return options.scheduler ? undefined : fn()
    }
    // effectStack没有当前effect时
    if (!effectStack.includes(effect)) {
      // 删除所有的deps
      cleanup(effect)
      try {
        // 设置shouldTrack为true
        enableTracking()
        // 存储当前effect
        effectStack.push(effect)
        // 设置activeEffect为当前effect
        activeEffect = effect
        // 执行fn，执行fn时会触发reactive的getter，进而触发track
        return fn()
      } finally {
        effectStack.pop()
        resetTracking()
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  // 注入属性
  effect.id = uid++
  effect._isEffect = true
  effect.active = true
  effect.raw = fn
  effect.deps = []
  effect.options = options
  return effect
}

// 删除所有的deps
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

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

// 跟踪：
// 在每一个key上维护了类似于下面的一个结构，保存了所有可能会调用这个key的函数
// { // targetMap
//   state: { // depsMap，state是target
//     name: [activeEffect] // dep：effects，name是key
//   }
// }
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // shouldTrack为false或当前effect未定义时直接返回
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  // 获取depsMap
  // targetMap是一个全局变量，是一个weakMap
  let depsMap = targetMap.get(target)
  // 不存在时设置当前target的depsMap并初始化为Map
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  // 获取当前key的dep
  // key就是reactive的key，比如state.name的name
  let dep = depsMap.get(key)
  // 不存在时新建dep并初始化为Set
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  // dep没有activeEffect时新建
  // watchEffect时activeEffect就是watch传进去的函数
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    // activeEffect中添加dep
    activeEffect.deps.push(dep)
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

// 触发依赖
// 当修改了reactive的值会触发trigger，比如state.name='xxx'
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 获取target的依赖Map，没有直接返回
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  // 声明effects
  const effects = new Set<ReactiveEffect>()
  // 声明add函数：添加effect到effects
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        // effect === activeEffect的情况就是：设置 effect(这时会设置activeEffect) 的同时触发了 trigger 依赖更新，会导致循环
        // 这种情况是不会添加effect除非设置了allowRecurse（允许递归）
        // 不推荐这么使用，一定要这么用必须设置上限，即设置结束条件
        if (effect !== activeEffect || effect.options.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }

  // targetMap结构参考：
  // { // targetMap
  //   state: { // depsMap，state是target
  //     name: [activeEffect] // dep：effects，name是key
  //   }
  // }

  // 数组：
  // {
  //   state: ['naixes', 'sin']
  // }
  // state.lenth = 1

  // { // targetMap
  //   state: { // depsMap，state是target
  //     0: [effect] // dep：effects，index是key
  //     1: [effect]
  //   }
  // }

  // 如果现在的操作是CLEAR：depsMap下所有的key都执行add
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) {
    // target是数组且key是length，即操作是修改数组长度
    depsMap.forEach((dep, key) => {
      // key是length或key大于等于新值。即缩短数组，添加超出部分的effect，之后要删除
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 其他情况
    // 判断操作是针对这个key的
    if (key !== void 0) {
      // 添加这个key所有的依赖
      // depsMap.get(key)：返回的就是dep的Set，[effect, effect, ...]
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    // 根据不同的type，增加其他的属性依赖
    switch (type) {
      case TriggerOpTypes.ADD:
        // ADD
        if (!isArray(target)) {
          // 不是数组
          // 依赖ITERATE_KEY和MAP_KEY_ITERATE_KEY增加
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // 是数组
          // new index added to array -> length changes
          // 增加length依赖
          add(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        // DELETE
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        // SET
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  // 定义run：执行effect
  const run = (effect: ReactiveEffect) => {
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    if (effect.options.scheduler) {
      // 存在scheduler时按照scheduler的方式执行effect
      effect.options.scheduler(effect)
    } else {
      // 否则直接执行
      effect()
    }
  }

  // 执行run
  effects.forEach(run)
}
