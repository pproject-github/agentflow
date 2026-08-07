# Web UI Lint Baseline

`builtin/web-ui/eslint.config.js` is the lint baseline for the Web UI.

```bash
cd builtin/web-ui
npm run lint          # current baseline: 0 errors / 62 warnings
npm run lint:strict   # treat warnings as failures, for tightening later
```

## Why it has to exist

**A passing `vite build` does not mean the code runs.**

Bundlers treat undeclared identifiers as globals: compilation succeeds and nothing
is reported until a `ReferenceError` is thrown at runtime. When removing dead code,
"declaration deleted but call site left behind" is the easiest mistake to make, and
it lands squarely in the blind spot shared by the build and the unit tests:

```js
// const [mentionHighlight, setMentionHighlight] = useState(0);  ← removed
// but this effect was missed — vite build still passes
useEffect(() => {
  setMentionHighlight((h) => Math.min(h, max));   // ReferenceError at runtime
}, [mentionMenuFlat]);
```

That effect runs on every render, so the page blanks the moment it opens. Hence
`no-undef` is an **error** with no exceptions.

## Rules

| Rule | Level | Notes |
|------|-------|-------|
| `no-undef` | error | See above. Currently 0 violations repo-wide |
| `react/jsx-uses-vars` | error | **Required**. Without it `<Foo />` does not count as a reference to `Foo` |
| `react/jsx-uses-react` | error | Same, for `React` itself |
| `no-unused-vars` | warn | 62 pre-existing; promote to error once cleared |
| `react-hooks/rules-of-hooks` | error | Hook call ordering |

### Why `react/jsx-uses-vars` is non-negotiable

Without the react plugin, `no-unused-vars` cannot see component references inside
JSX and reports every **actively used** import — `FlowBoard`, `ReactFlow`,
`ConfirmModal` and friends — as unused. Measured before and after enabling it:
227 reports → 71, meaning **156 were false positives**.

This is not merely noise. Acting on that report and deleting the "unused"
components would delete the canvas itself. Any removal driven by `no-unused-vars`
must first confirm this rule is enabled.

## Recommended order for removing dead code

1. Remove **consumers** first (JSX, event handlers), then the state and functions
   they referenced
2. Run `npm run lint` after each step — let the tool decide what is referenced.
   Do not hand-roll brace matching (regex literals, template strings and brackets
   inside string literals all break naive parsers)
3. `npm run build` only validates syntax, never reference integrity. It is not a
   substitute for lint
4. For changes touching `/flow-preview`, finish by opening the page in a real
   browser and confirming it renders
