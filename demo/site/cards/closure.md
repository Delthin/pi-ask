---
id: "closure"
title: "闭包"
summary: "函数与定义时的词法环境一起保存，外层函数返回后仍能访问其变量。"
created: "2024-01-01T09:00:00.000Z"
updated: "2024-01-02T09:00:00.000Z"
---

# 闭包

> 预设演示内容，不来自用户会话。

闭包是函数和它定义时所处词法环境的组合。外层函数返回后，返回的函数仍然引用外层变量，这些变量因此继续存在，可以读取和修改。

下面的计数器把 `count` 留在 `makeCounter` 的作用域里，返回的函数每次调用都操作同一个 `count`：

```js
function makeCounter() {
  let count = 0;
  return () => ++count;
}

const next = makeCounter();
console.log(next()); // 1
console.log(next()); // 2
```

`makeCounter()` 调用结束后，`count` 没有随调用结束而消失，因为返回的箭头函数持有对它的引用。每次调用 `next` 读到的是同一个 `count`，状态因此延续。

闭包常用来保存私有状态，也用来让回调记住定义时的参数。变量的生命周期由是否仍被引用决定，函数调用是否结束不直接决定它。

---

## 2024-01-02T09:00:00.000Z

<!-- record:demo-javascript -->
内容来源：预设示例

### 相关原始问答

[原始消息 message-0](../discussions/demo-javascript.md#message-0)

### 用户问题（user） · 2024-01-01T09:00:00.000Z

为什么说闭包会让变量“活得比函数调用更久”？

[原始消息 message-1](../discussions/demo-javascript.md#message-1)

### 示例回答（预设） · 2024-01-01T09:00:30.000Z

函数返回后，它的调用帧会退出。闭包让函数继续访问定义时的词法环境，返回的函数仍能读取和修改其中的外层变量。被闭包引用的对象能否回收，要看它们是否还从根对象可达。
