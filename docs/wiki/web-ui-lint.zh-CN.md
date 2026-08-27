# Web UI 静态检查基线

`builtin/web-ui/eslint.config.js` 是 Web UI 的 lint 基线。

```bash
cd builtin/web-ui
npm run lint          # 当前基线：0 error / 39 warning
npm run lint:strict   # 把 warning 也当失败，供后续收紧用
```

## 为什么必须有它

**`vite build` 通过 ≠ 代码能跑。**

打包器把未声明的标识符当作全局变量处理，编译阶段不报任何错，直到运行时才抛
`ReferenceError`。清理死代码时，「声明删了但调用点还在」是最容易漏的一类错误，
而它恰好落在 build 和单元测试的共同盲区里：

```js
// 删掉了 const [mentionHighlight, setMentionHighlight] = useState(0);
// 却漏了这个 effect —— vite build 照样通过
useEffect(() => {
  setMentionHighlight((h) => Math.min(h, max));   // 运行时 ReferenceError
}, [mentionMenuFlat]);
```

上面这个 effect 每次渲染都会执行，等于页面一打开就白屏。所以 `no-undef` 设为
**error**，不接受例外。

## 规则说明

| 规则 | 级别 | 说明 |
|------|------|------|
| `no-undef` | error | 见上。当前全仓库 0 违规 |
| `react/jsx-uses-vars` | error | **必需**。缺了它，`<Foo />` 不被算作对 `Foo` 的引用 |
| `react/jsx-uses-react` | error | 同上，覆盖 `React` 本身 |
| `no-unused-vars` | warn | 存量 39 条，清完后应提升为 error |
| `react-hooks/rules-of-hooks` | error | Hook 调用顺序 |

### `react/jsx-uses-vars` 为什么是硬性的

没有 react 插件时，`no-unused-vars` 看不见 JSX 里的组件引用，会把 `FlowBoard`、
`ReactFlow`、`ConfirmModal` 等**正在使用**的导入全部报成未使用。实测启用前后是
227 条 → 71 条，也就是说 **156 条是假阳性**。

这不只是噪音问题：如果照着未启用插件时的报告去删「未使用」的组件，会直接把画布
删掉。任何依据 `no-unused-vars` 做删除的操作，都必须先确认这条规则是开着的。

## 清理死代码的推荐顺序

1. 先删**消费方**（JSX、事件回调），再删被它引用的状态与函数
2. 每删一步跑一次 `npm run lint` —— 用工具判定引用关系，不要靠手写脚本推断
   括号配平（正则字面量、模板串、字符串里的括号都会让自制解析器误判）
3. `npm run build` 只能验证语法，验证不了引用完整性，不能替代 lint
4. 涉及 `/flow-preview` 的改动，最后要在浏览器里实际打开确认渲染
