import { FileNode, ChatMessage, AIProvider } from "./types";

export const mockFileTree: FileNode[] = [
  {
    id: "1",
    name: "src",
    type: "folder",
    path: "src",
    children: [
      {
        id: "1-1",
        name: "components",
        type: "folder",
        path: "src/components",
        children: [
          {
            id: "1-1-1",
            name: "Button.tsx",
            type: "file",
            path: "src/components/Button.tsx",
            language: "typescript",
            content: `import React from "react";

interface ButtonProps {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
}

export const Button: React.FC<ButtonProps> = ({
  label,
  onClick,
  variant = "primary",
}) => {
  return (
    <button
      onClick={onClick}
      className={variant === "primary" ? "btn-primary" : "btn-secondary"}
    >
      {label}
    </button>
  );
};
`,
          },
          {
            id: "1-1-2",
            name: "Header.tsx",
            type: "file",
            path: "src/components/Header.tsx",
            language: "typescript",
            content: `import React from "react";

export const Header: React.FC = () => {
  return (
    <header className="header">
      <h1>My App</h1>
    </header>
  );
};
`,
          },
        ],
      },
      {
        id: "1-2",
        name: "utils",
        type: "folder",
        path: "src/utils",
        children: [
          {
            id: "1-2-1",
            name: "helpers.ts",
            type: "file",
            path: "src/utils/helpers.ts",
            language: "typescript",
            content: `export const formatDate = (date: Date): string => {
  return date.toISOString().split("T")[0];
};

export const debounce = <T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) => {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};
`,
          },
        ],
      },
      {
        id: "1-3",
        name: "App.tsx",
        type: "file",
        path: "src/App.tsx",
        language: "typescript",
        content: `import React from "react";
import { Button } from "./components/Button";
import { Header } from "./components/Header";

const App: React.FC = () => {
  const handleClick = () => {
    console.log("Clicked!");
  };

  return (
    <div className="app">
      <Header />
      <main>
        <Button label="Click me" onClick={handleClick} />
      </main>
    </div>
  );
};

export default App;
`,
      },
      {
        id: "1-4",
        name: "index.tsx",
        type: "file",
        path: "src/index.tsx",
        language: "typescript",
        content: `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
      },
    ],
  },
  {
    id: "2",
    name: "public",
    type: "folder",
    path: "public",
    children: [
      {
        id: "2-1",
        name: "index.html",
        type: "file",
        path: "public/index.html",
        language: "html",
        content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>My App</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
      },
    ],
  },
  {
    id: "3",
    name: "package.json",
    type: "file",
    path: "package.json",
    language: "json",
    content: `{
  "name": "my-app",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  }
}
`,
  },
  {
    id: "4",
    name: "README.md",
    type: "file",
    path: "README.md",
    language: "markdown",
    content: `# My App

A simple React application built with Vite.

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`
`,
  },
];

export const mockChatMessages: ChatMessage[] = [
  {
    id: "1",
    role: "assistant",
    content: "Привет! Я ComposeVC. Чем могу помочь с твоим кодом?",
    timestamp: Date.now() - 60000,
  },
  {
    id: "2",
    role: "user",
    content: "Посмотри на компонент Button.tsx, мне нужно добавить disabled state",
    timestamp: Date.now() - 45000,
  },
  {
    id: "3",
    role: "assistant",
    content:
      "Конечно! Я добавлю свойство `disabled` в интерфейс `ButtonProps` и применю стили для отключённой кнопки. Хочешь, чтобы я внёс изменения прямо в редакторе?",
    timestamp: Date.now() - 30000,
  },
];

export const mockProviders: AIProvider[] = [
  {
    id: "1",
    name: "OpenAI",
    type: "openai",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "2",
    name: "Anthropic",
    type: "anthropic",
    apiKey: "",
    baseUrl: "https://api.anthropic.com",
  },
];
