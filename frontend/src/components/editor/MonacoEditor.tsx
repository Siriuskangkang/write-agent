'use client';

import { useEffect, useRef } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

interface MonacoEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: 'json' | 'markdown';
  height?: string;
  readOnly?: boolean;
  jsonSchema?: object;
}

export default function MonacoEditor({
  value,
  onChange,
  language,
  height = '400px',
  readOnly = false,
  jsonSchema,
}: MonacoEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // 配置 JSON schema 验证
    if (language === 'json' && jsonSchema) {
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
        validate: true,
        schemas: [
          {
            uri: 'http://myserver/outline-schema.json',
            fileMatch: ['*'],
            schema: jsonSchema,
          },
        ],
      });
    }

    // 自动格式化 JSON
    if (language === 'json') {
      setTimeout(() => {
        editor.getAction('editor.action.formatDocument')?.run();
      }, 100);
    }
  };

  const handleChange = (value: string | undefined) => {
    onChange(value ?? '');
  };

  return (
    <div style={{ border: '1px solid #d9d9d9', borderRadius: 4, overflow: 'hidden' }}>
      <Editor
        height={height}
        language={language}
        value={value}
        onChange={handleChange}
        onMount={handleEditorDidMount}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          wrappingIndent: 'indent',
          automaticLayout: true,
          tabSize: 2,
          insertSpaces: true,
          formatOnPaste: true,
          formatOnType: language === 'json',
        }}
        theme="vs"
      />
    </div>
  );
}
