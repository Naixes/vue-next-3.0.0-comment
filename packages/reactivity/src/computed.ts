import { effect, ReactiveEffect, trigger, track } from './effect'
import { TriggerOpTypes, TrackOpTypes } from './operations'
import { Ref } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (ctx?: any) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

class ComputedRefImpl<T> {
  private _value!: T
  // 默认为true
  private _dirty = true

  public readonly effect: ReactiveEffect<T>

  // computed也是一个ref
  public readonly __v_isRef = true;
  public readonly [ReactiveFlags.IS_READONLY]: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    // 根据是否有setter判断的
    isReadonly: boolean
  ) {
    this.effect = effect(getter, {
      // lazy（懒更新）：当它依赖数据更新时不会立刻更新，只有自己被调用的时候才更新
      lazy: true,
      scheduler: () => {
        // _dirty为false时执行
        // 这里没有做更新操作只是改变了_dirty，get时才会真正更新？？？
        if (!this._dirty) {
          this._dirty = true
          // 更新
          trigger(toRaw(this), TriggerOpTypes.SET, 'value')
        }
      }
    })

    // 更新标记
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  get value() {
    // 更新
    if (this._dirty) {
      this._value = this.effect()
      this._dirty = false
    }
    // 跟踪
    track(toRaw(this), TrackOpTypes.GET, 'value')
    return this._value
  }

  set value(newValue: T) {
    this._setter(newValue)
  }
}

export function computed<T>(getter: ComputedGetter<T>): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>
export function computed<T>(
  // 接收函数或者option，函数就是getter，对象就是getter和setter
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  // 获取参数中的getter和setter
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  // 实例化
  return new ComputedRefImpl(
    getter,
    setter,
    // 是否有setter
    isFunction(getterOrOptions) || !getterOrOptions.set
  ) as any
}
