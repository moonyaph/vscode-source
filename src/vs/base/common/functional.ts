export function once<T extends Function>(this: unknown, fn: T): T {
  let called = false
  const _this = this
  let result: unknown
  return function () {
    if (called) {
      return result
    }
    called = true
    result = fn.apply(_this, arguments)
    return result
  } as unknown as T
}
