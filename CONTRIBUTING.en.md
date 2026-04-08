# Contributing to AgentFlow

[中文](./CONTRIBUTING.zh-CN.md) | **English**

Thanks for your interest in AgentFlow! Here's a guide for contributing.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/bigo-sg/agentflow.git
cd agentflow

# Install dependencies (use npm public registry)
npm install

# Link globally for testing
npm link

# Verify
agentflow --help
```

## Project Structure

```
.
├── bin/              # CLI entry and pipeline scripts
│   ├── agentflow.mjs # Main CLI
│   └── pipeline/     # apply/replay phase scripts
├── agents/           # Node executor agent definitions (.md)
├── builtin/          # Built-in pipelines, Web UI
│   ├── pipelines/    # Sample/built-in flow.yaml
│   └── web-ui/       # Visual editor
├── reference/        # Reference docs and schemas
└── .cursor/skills/   # Cursor skills (for development)
```

## Submitting Pull Requests

1. **Fork the repo** and create your branch (`git checkout -b feature/amazing-feature`)
2. **Ensure code runs**: `npm install` and basic CLI commands work
3. **Web UI changes**: If you modified `builtin/web-ui/`, ensure `npm run build` succeeds
4. **Commit messages**: Use clear commit messages describing your changes
5. **Open a PR**: Describe the purpose and testing method

## Code Style

- Use ES Module (`type: "module"`)
- Keep consistent naming and structure with existing code
- Add necessary comments for non-obvious logic

## Internationalization Guide

AgentFlow supports i18n for CLI, Web UI, and Agent definitions. To add a new language or improve translations:

### Adding a New Language (e.g., French `fr`)

#### 1. CLI Translations

Create `bin/lib/locales/fr.json`, following the structure of existing language files.

#### 2. Web UI Translations

Create these files:
- `builtin/web-ui/src/i18n/locales/fr/common.json`
- `builtin/web-ui/src/i18n/locales/fr/flow.json`
- `builtin/web-ui/src/i18n/locales/fr/settings.json`
- `builtin/web-ui/src/i18n/locales/fr/composer.json`

Then import and register in `builtin/web-ui/src/i18n/index.js`:

```javascript
import frCommon from './locales/fr/common.json';
// ... other imports

const resources = {
  // ... existing languages
  fr: {
    common: frCommon,
    // ... other namespaces
  },
};
```

#### 3. Agent Definition Translations

Create `agents/fr/` directory and translate main agent definition files:
- `agentflow-node-executor.md`
- `agentflow-node-executor-code.md`
- `agentflow-node-executor-planning.md`
- `agentflow-node-executor-requirement.md`
- `agentflow-node-executor-test.md`
- `agentflow-node-executor-ui.md`

#### 4. Register Language

Update `SUPPORTED_LANGUAGES` in these files:
- `bin/lib/i18n.mjs`
- `builtin/web-ui/src/i18n/index.js`

### Translation Notes

- **Keep placeholders consistent**: Interpolation variables like `{{name}}`, `{{count}}`
- **Keep namespace structure consistent**: CLI and Web UI use the same key structure
- **Test language switching**: Verify in Web UI Settings page
- **Validate RTL languages** (Arabic, Hebrew): May need CSS adjustments

## Reporting Issues

Found a bug or have a feature suggestion? Please submit via [GitHub Issues](../../issues), including:
- Description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment info (Node version, OS)

## License

By submitting a PR, you agree your contributions will be licensed under the [MIT License](LICENSE).