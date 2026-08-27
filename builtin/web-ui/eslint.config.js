import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import react from "eslint-plugin-react";

/**
 * Web UI 的静态检查基线。
 *
 * 存在的理由：`vite build` 对「标识符已被删除但调用点还在」是**沉默的** —— 打包器
 * 把未声明的名字当全局变量处理，编译照过，运行时才 ReferenceError。清理死代码时
 * 这类漏删只有 no-undef 能抓到，所以它是硬错误。
 *
 * no-unused-vars 目前是 warn：仓库里还有约 220 处历史遗留，一次性修完不现实。
 * 它的价值在于给「某段代码是否真的没人用」提供工具判定，避免靠手写脚本猜引用
 * 关系。清完存量后应提升为 error。
 */
export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.{js,jsx}"],
    plugins: { "react-hooks": reactHooks, react },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        __APP_VERSION__: "readonly",
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      "no-undef": "error",
      // 必需：没有它，`<Foo />` 不算对 Foo 的引用，no-unused-vars 会把所有
      // 组件与 JSX 里用到的导入误报成未使用 —— 照着删会直接删掉画布。
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "no-unused-vars": [
        "warn",
        {
          args: "none",
          caughtErrors: "none",
          ignoreRestSiblings: true,
          // JSX 组件名与常量以大写开头，构建期可能仅在类型注释中出现
          varsIgnorePattern: "^_",
        },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
