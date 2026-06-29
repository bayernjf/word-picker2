import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // 边界处（JSON 解析、旧数据兼容）暂留 any，降为警告不阻断，后续渐进收紧
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
      "prefer-const": "warn",
      "eqeqeq": ["warn", "smart"]
    }
  },
  {
    // content scripts 通过 manifest 按普通脚本顺序加载，非 ES module
    files: ["content/**/*.ts", "content/**/*.js"],
    languageOptions: {
      sourceType: "script"
    }
  },
  {
    files: ["tests/**/*.ts", "tests/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ["scripts/**/*.ts", "scripts/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    ignores: ["node_modules/**", "dist/**", "assets/**"]
  }
);
