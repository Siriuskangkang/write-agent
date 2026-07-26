'use client';

import { useState } from 'react';
import { Form, Input, Switch, Button, Card, Space, Divider, message } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import type { OutlineContent } from '@/types';

interface OutlineFormEditorProps {
  value: OutlineContent;
  onChange: (value: OutlineContent) => void;
}

export default function OutlineFormEditor({ value, onChange }: OutlineFormEditorProps) {
  const [form] = Form.useForm();

  // 初始化表单值
  const initialValues = {
    node_title: value.node_title || '',
    level: value.level || '',
    sections: value.sections || [],
    key_points: value.key_points || [],
    difficulties: value.difficulties || [],
    source_refs: value.source_refs || [],
  };

  // 表单值变化时更新父组件
  const handleValuesChange = (_: any, allValues: any) => {
    onChange({
      node_title: allValues.node_title,
      level: allValues.level,
      sections: allValues.sections || [],
      key_points: allValues.key_points || [],
      difficulties: allValues.difficulties || [],
      source_refs: allValues.source_refs || [],
    });
  };

  return (
    <div style={{ padding: '16px 0' }}>
      <Form
        form={form}
        layout="vertical"
        initialValues={initialValues}
        onValuesChange={handleValuesChange}
      >
        {/* 基本信息 */}
        <Card size="small" title="基本信息" style={{ marginBottom: 16 }}>
          <Form.Item label="节点标题" name="node_title">
            <Input placeholder="例如：第1模块 AI智能语音技术概述" />
          </Form.Item>
          <Form.Item label="层级" name="level">
            <Input placeholder="例如：模块" />
          </Form.Item>
        </Card>

        {/* 栏目列表 */}
        <Card size="small" title="栏目列表" style={{ marginBottom: 16 }}>
          <Form.List name="sections">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field, index) => (
                  <Card
                    key={field.key}
                    size="small"
                    type="inner"
                    title={`栏目 ${index + 1}`}
                    extra={
                      <Button
                        type="text"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        onClick={() => remove(field.name)}
                      >
                        删除
                      </Button>
                    }
                    style={{ marginBottom: 12 }}
                  >
                    <Form.Item
                      {...field}
                      label="栏目名称"
                      name={[field.name, 'column']}
                      rules={[{ required: true, message: '请输入栏目名称' }]}
                    >
                      <Input placeholder="例如：导读案例" />
                    </Form.Item>

                    <Form.Item
                      {...field}
                      label="是否必需"
                      name={[field.name, 'required']}
                      valuePropName="checked"
                    >
                      <Switch checkedChildren="必需" unCheckedChildren="可选" />
                    </Form.Item>

                    <Form.Item
                      {...field}
                      label="写作指导"
                      name={[field.name, 'writing_guide']}
                      rules={[{ required: true, message: '请输入写作指导' }]}
                    >
                      <Input.TextArea
                        rows={3}
                        placeholder="例如：语言生动，聚焦一个具体、真实的案例"
                      />
                    </Form.Item>

                    <Form.Item
                      {...field}
                      label="篇幅建议"
                      name={[field.name, 'length_suggestion']}
                      rules={[{ required: true, message: '请输入篇幅建议' }]}
                    >
                      <Input placeholder="例如：300-500字" />
                    </Form.Item>

                    <Form.Item label="内容要点">
                      <Form.List name={[field.name, 'content_points']}>
                        {(pointFields, { add: addPoint, remove: removePoint }) => (
                          <>
                            {pointFields.map((pointField) => (
                              <Space key={pointField.key} style={{ display: 'flex', marginBottom: 8 }}>
                                <Form.Item
                                  {...pointField}
                                  noStyle
                                  rules={[{ required: true, message: '请输入内容要点' }]}
                                >
                                  <Input placeholder="内容要点" style={{ width: 400 }} />
                                </Form.Item>
                                <Button
                                  type="text"
                                  danger
                                  icon={<DeleteOutlined />}
                                  onClick={() => removePoint(pointField.name)}
                                />
                              </Space>
                            ))}
                            <Button
                              type="dashed"
                              onClick={() => addPoint()}
                              block
                              icon={<PlusOutlined />}
                            >
                              添加内容要点
                            </Button>
                          </>
                        )}
                      </Form.List>
                    </Form.Item>
                  </Card>
                ))}
                <Button
                  type="dashed"
                  onClick={() => add({
                    column: '',
                    required: true,
                    writing_guide: '',
                    length_suggestion: '',
                    content_points: [],
                  })}
                  block
                  icon={<PlusOutlined />}
                  style={{ marginTop: 8 }}
                >
                  添加栏目
                </Button>
              </>
            )}
          </Form.List>
        </Card>

        {/* 重点 */}
        <Card size="small" title="重点" style={{ marginBottom: 16 }}>
          <Form.List name="key_points">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Space key={field.key} style={{ display: 'flex', marginBottom: 8 }}>
                    <Form.Item {...field} noStyle>
                      <Input placeholder="重点内容" style={{ width: 500 }} />
                    </Form.Item>
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => remove(field.name)}
                    />
                  </Space>
                ))}
                <Button
                  type="dashed"
                  onClick={() => add()}
                  block
                  icon={<PlusOutlined />}
                >
                  添加重点
                </Button>
              </>
            )}
          </Form.List>
        </Card>

        {/* 难点 */}
        <Card size="small" title="难点" style={{ marginBottom: 16 }}>
          <Form.List name="difficulties">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Space key={field.key} style={{ display: 'flex', marginBottom: 8 }}>
                    <Form.Item {...field} noStyle>
                      <Input placeholder="难点内容" style={{ width: 500 }} />
                    </Form.Item>
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => remove(field.name)}
                    />
                  </Space>
                ))}
                <Button
                  type="dashed"
                  onClick={() => add()}
                  block
                  icon={<PlusOutlined />}
                >
                  添加难点
                </Button>
              </>
            )}
          </Form.List>
        </Card>

        {/* 参考资料 */}
        <Card size="small" title="参考资料" style={{ marginBottom: 16 }}>
          <Form.List name="source_refs">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field, index) => (
                  <Card
                    key={field.key}
                    size="small"
                    type="inner"
                    title={`参考资料 ${index + 1}`}
                    extra={
                      <Button
                        type="text"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        onClick={() => remove(field.name)}
                      >
                        删除
                      </Button>
                    }
                    style={{ marginBottom: 12 }}
                  >
                    <Form.Item
                      {...field}
                      label="文件名"
                      name={[field.name, 'file']}
                      rules={[{ required: true, message: '请输入文件名' }]}
                    >
                      <Input placeholder="例如：Page 26" />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      label="页码范围"
                      name={[field.name, 'pages']}
                    >
                      <Input placeholder="例如：8-12" />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      label="相关性"
                      name={[field.name, 'relevance']}
                      rules={[{ required: true, message: '请输入相关性' }]}
                    >
                      <Input placeholder="例如：高" />
                    </Form.Item>
                  </Card>
                ))}
                <Button
                  type="dashed"
                  onClick={() => add({ file: '', pages: '', relevance: '' })}
                  block
                  icon={<PlusOutlined />}
                  style={{ marginTop: 8 }}
                >
                  添加参考资料
                </Button>
              </>
            )}
          </Form.List>
        </Card>
      </Form>
    </div>
  );
}
