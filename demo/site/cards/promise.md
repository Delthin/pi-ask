---
id: "promise"
title: "Promise"
summary: "表示异步操作最终结果的对象，用 then 串联后续处理并统一传递错误。"
created: "2024-01-01T09:00:00.000Z"
updated: "2024-01-02T09:00:00.000Z"
---

# Promise

> 预设演示内容，不来自用户会话。

---

## 2024-01-02T09:00:00.000Z

<!-- record:demo-javascript -->
整理模型：预设示例（未调用模型）

### Promise

#### 知识整理

Promise 表示一个异步操作的最终结果，状态为 pending、fulfilled 或 rejected，状态一旦确定就不再改变。`then` 注册的回调在结果可用后进入微任务队列执行。

```js
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

delay(100)
  .then(() => console.log("完成"))
  .catch(error => console.error(error));
```

`delay` 把 `resolve` 交给 `setTimeout`，定时器到点后调用它，Promise 变为 fulfilled，`.then` 的回调随后执行。`then` 返回一个新的 Promise，后续处理可以继续串联。

回调会捕获定义处的变量，这是闭包在异步流程中的常见用法：回调执行时读到的仍是书写位置作用域里的值。错误通过 `reject` 或抛出的异常传到 `catch`，统一处理。

### 相关原始问答

[原始消息 message-6](../discussions/demo-javascript.md#message-6)

### 用户问题（user） · 2024-01-01T09:03:00.000Z

Promise 的 then 回调为什么能用到外面的变量？

[原始消息 message-7](../discussions/demo-javascript.md#message-7)

### 示例回答（预设） · 2024-01-01T09:03:30.000Z

回调和普通函数一样携带定义时的词法环境。then 注册的回调在微任务中执行，作用域链仍然指向书写位置，因此能读到外层变量。
