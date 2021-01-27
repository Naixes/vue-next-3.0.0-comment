import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  enableTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend
} from '@vue/shared'
import { isRef } from './ref'

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

// 获取不同的get函数 shallow readonly
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
// instrument length-altering mutation methods to avoid length being tracked
// which leads to infinite loops in some cases (#2137)
;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
  const method = Array.prototype[key] as any
  arrayInstrumentations[key] = function(this: unknown[], ...args: unknown[]) {
    pauseTracking()
    const res = method.apply(this, args)
    enableTracking()
    return res
  }
})

// 返回get函数
function createGetter(isReadonly = false, shallow = false) {
  // 例如执行arr.indexOf() target就是arr indexOf就是key receiver就是proxy对象
  return function get(target: Target, key: string | symbol, receiver: object) {
    // 特殊key的读取
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

// reative函数传入的Handlers
export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
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

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers: ProxyHandler<object> = extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
