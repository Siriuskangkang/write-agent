'use client';

import { Form, Input, Button, Space, Card } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import type { StyleTemplateData } from './types';

interface StyleTemplateEditorProps {
  initialData?: Partial<StyleTemplateData>;
  onSave: (data: StyleTemplateData) => void;
  onCancel: () => void;
}

export function StyleTemplateEditor({ initialData, onSave, onCancel }: StyleTemplateEditorProps) {
  const [form] = Form.useForm();

  const handleSubmit = (values: StyleTemplateData) => {
    onSave(values);
  };

  return (
    <Card title="编辑体例">
      <Form
        form={form}
        layout="vertical"
        initialValues={initialData}
        onFinish={handleSubmit}
      >
        <Form.Item
          label="体例名称"
          name="name"
          rules={[{ required: true, message: '请输入体例名称' }]}
        >
          <Input placeholder="例如：学术论文体例" />
        </Form.Item>

        <Form.List name="rules">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }) => (
                <Card key={key} size="small" style={{ marginBottom: 16 }}>
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Form.Item
                      {...restField}
                      name={[name, 'category']}
                      rules={[{ required: true, message: '请输入规则类别' }]}
                    >
                      <Input placeholder="规则类别（如：标题格式）" />
                    </Form.Item>
                    <Form.Item
                      {...restField}
                      name={[name, 'description']}
                      rules={[{ required: true, message: '请输入规则描述' }]}
                    >
                      <Input.TextArea placeholder="规则描述" rows={3} />
                    </Form.Item>
                    <Form.Item {...restField} name={[name, 'example']}>
                      <Input placeholder="示例（可选）" />
                    </Form.Item>
                    <Button
                      type="link"
                      danger
                      icon={<MinusCircleOutlined />}
                      onClick={() => remove(name)}
                    >
                      删除规则
                    </Button>
                  </Space>
                </Card>
              ))}
              <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                添加规则
              </Button>
            </>
          )}
        </Form.List>

        <Form.Item style={{ marginTop: 24 }}>
          <Space>
            <Button type="primary" htmlType="submit">
              保存
            </Button>
            <Button onClick={onCancel}>取消</Button>
          </Space>
        </Form.Item>
      </Form>
    </Card>
  );
}
