---
id: "garbage-collection"
title: "垃圾回收"
summary: "从根对象出发标记可达对象，回收不可达对象占用的内存。"
created: "2024-01-01T09:00:00.000Z"
updated: "2024-01-02T09:00:00.000Z"
---

# 垃圾回收

> 预设演示内容，不来自用户会话。

垃圾回收自动释放不再使用的对象占用的内存。JavaScript 引擎常用标记清除：从根对象出发，沿着引用关系标记所有能到达的对象，没有标记的对象不可达，随后被回收。

可达性由引用链决定，而不取决于变量名是否还在作用域里。闭包持有外层变量时，这条引用从函数对象延伸到变量，变量因此保持可达。

```js
function createCache() {
  const data = new Array(1000).fill(0);
  return () => data.length;
}

let size = createCache();
console.log(size()); // 1000

size = null;
```

`size` 指向返回的函数，函数引用 `data`，所以只要 `size` 还在使用，`data` 就保持可达。把 `size` 置为 `null` 后，函数和它引用的数组都不再可达，可以在之后的回收中释放。

回收时机由引擎决定，代码无法精确控制。需要及时释放大对象时，减少长生命周期的引用比等待回收更直接。

---

## 2024-01-02T09:00:00.000Z

<!-- record:demo-javascript -->
内容来源：预设示例

### 相关原始问答

[原始消息 message-4](../discussions/demo-javascript.md#message-4)

### 用户问题（user） · 2024-01-01T09:02:00.000Z

闭包占用的内存什么时候能被回收？

[原始消息 message-5](../discussions/demo-javascript.md#message-5)

### 示例回答（预设） · 2024-01-01T09:02:30.000Z

当相关对象不再从根对象可达时，就可以被回收。一个仍然可达的闭包可能通过词法环境保留外层对象；移除这条引用以及其他引用后，对象就不再可达。实际回收时机由引擎决定。
