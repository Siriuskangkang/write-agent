'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Upload, message, Popconfirm, Spin } from 'antd';
import {
  InboxOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  FileMarkdownOutlined,
  FileTextOutlined,
  FileUnknownOutlined,
  ReloadOutlined,
  DeleteOutlined,
  CloudUploadOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { fileService } from '@/services/fileService';
import { useProjectStore } from '@/stores/projectStore';
import type { SourceFile } from '@/types';
import { ParseStatus, FileType } from '@/types';

const { Dragger } = Upload;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const fileTypeIcons: Record<string, React.ReactNode> = {
  [FileType.PDF]: <FilePdfOutlined style={{ fontSize: 16, color: 'var(--brand-danger)' }} />,
  [FileType.DOCX]: <FileWordOutlined style={{ fontSize: 16, color: 'var(--brand-primary)' }} />,
  [FileType.MD]: <FileMarkdownOutlined style={{ fontSize: 16, color: 'var(--brand-success)' }} />,
  [FileType.TXT]: <FileTextOutlined style={{ fontSize: 16, color: 'var(--gray-500)' }} />,
};

function StatusBadge({ status }: { status: ParseStatus }) {
  const cfg = {
    [ParseStatus.PENDING]: { label: '等待解析', bg: 'var(--surface-bg)', color: 'var(--gray-500)', border: 'var(--surface-border)', pulse: false },
    [ParseStatus.PARSING]: { label: '解析中', bg: 'var(--brand-primary-light)', color: 'var(--brand-primary)', border: 'var(--brand-accent)', pulse: true },
    [ParseStatus.DONE]: { label: '已完成', bg: 'var(--brand-success-light)', color: 'var(--brand-success)', border: 'var(--brand-success-border)', pulse: false },
    [ParseStatus.FAILED]: { label: '解析失败', bg: 'var(--brand-danger-light)', color: 'var(--brand-danger)', border: 'var(--brand-danger-border)', pulse: false },
  }[status] ?? { label: '未知', bg: 'var(--surface-bg)', color: 'var(--gray-500)', border: 'var(--surface-border)', pulse: false };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 500,
        padding: '3px 8px',
        borderRadius: 'var(--radius-sm)',
        background: cfg.bg,
        color: cfg.color,
        border: `1px solid ${cfg.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        className={cfg.pulse ? 'status-dot-active' : undefined}
        style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, flexShrink: 0 }}
      />
      {cfg.label}
    </span>
  );
}

function MaterialsContent() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const currentProject = useProjectStore((state) => state.currentProject);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const uploadingFilesRef = useRef(new Set<string>());

  const fetchFiles = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fileService.listFiles(projectId, { page: 1, page_size: 100 });
      if (res.success) setFiles(res.data.items);
    } catch {
      message.error('加载文件列表失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  useEffect(() => {
    const hasPending = files.some(
      (file) => file.parse_status === ParseStatus.PENDING || file.parse_status === ParseStatus.PARSING,
    );

    if (!hasPending) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const res = await fileService.listFiles(projectId, { page: 1, page_size: 100 });
        if (res.success) setFiles(res.data.items);
      } catch {
        /* silent polling error */
      }
    }, 3000);

    return () => clearInterval(timer);
  }, [files, projectId]);

  const handleDelete = async (fileId: string) => {
    try {
      const res = await fileService.deleteFile(projectId, fileId);
      if (res.success) {
        message.success('文件已删除');
        setFiles((prev) => prev.filter((file) => file.id !== fileId));
      } else {
        message.error('删除失败');
      }
    } catch {
      message.error('删除文件失败');
    }
  };

  const handleReparse = async (fileId: string) => {
    try {
      const res = await fileService.reparseFile(projectId, fileId);
      if (res.success) {
        message.success('已重新提交解析');
        fetchFiles();
      }
    } catch {
      message.error('重新解析失败');
    }
  };

  const uploadProps: UploadProps = {
    name: 'files',
    multiple: true,
    showUploadList: false,
    accept: '.pdf,.docx,.doc,.md,.txt,.pptx',
    customRequest: async ({ file, onSuccess, onError }) => {
      const fileName = (file as File).name;
      if (uploadingFilesRef.current.has(fileName)) return;
      uploadingFilesRef.current.add(fileName);
      try {
        setUploading(true);
        const res = await fileService.uploadFiles(projectId, [file as File]);

        if (res.success) {
          onSuccess?.(res.data);
          message.success(`成功上传 ${fileName}`);
          fetchFiles();
        } else {
          onError?.(new Error(res.message ?? '上传失败'));
          message.error('上传失败');
        }
      } catch (err) {
        onError?.(err as Error);
        message.error('上传文件失败');
      } finally {
        uploadingFilesRef.current.delete(fileName);
        setUploading(false);
      }
    },
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', paddingBottom: 8 }}>
      <div className="project-page-hero">
        <div>
          <h1>素材管理</h1>
          <p>上传参考资料，AI 将基于素材内容生成目录、大纲与正文。</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => router.push(`/projects/${projectId}`)}
            style={{
              height: 38,
              padding: '0 14px',
              borderRadius: 14,
              border: '1px solid #DCE8F8',
              background: '#FFFFFF',
              color: '#5E7DA6',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            返回工作台
          </button>
          <span style={{ fontSize: 12, color: '#7F95B2' }}>{currentProject?.name ?? '当前项目'} · {files.length} 个文件</span>
        </div>
      </div>

      <div className="project-page-card" style={{ padding: 20 }}>
        <div style={{ marginBottom: 20 }}>
          <Dragger
            {...uploadProps}
            style={{
              background: uploading ? 'var(--brand-primary-light)' : '#F9FBFF',
              border: `2px dashed ${uploading ? 'var(--brand-primary)' : '#D5E3F6'}`,
              borderRadius: 24,
              transition: 'border-color var(--transition), background var(--transition)',
              padding: '12px 0',
            }}
          >
            <div style={{ padding: '26px 0' }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 18,
                  background: uploading ? 'var(--brand-primary)' : 'var(--brand-primary-light)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 16px',
                  transition: 'background var(--transition)',
                }}
              >
                {uploading ? <Spin size="small" /> : <CloudUploadOutlined style={{ fontSize: 24, color: 'var(--brand-primary)' }} />}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#192877', marginBottom: 6 }}>
                {uploading ? '上传中...' : '点击或拖拽文件到此处上传'}
              </div>
              <div style={{ fontSize: 12, color: '#7F95B2' }}>
                支持 PDF、Word、Markdown、TXT、PPTX，可批量上传
              </div>
            </div>
          </Dragger>
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
            <Spin size="large" />
          </div>
        ) : files.length === 0 ? (
          <div
            style={{
              background: '#F9FBFF',
              border: '1px dashed #C8DBF3',
              borderRadius: 24,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '68px 20px',
              gap: 10,
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 18,
                background: '#FFFFFF',
                border: '1px solid #DDE8F6',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 4,
              }}
            >
              <InboxOutlined style={{ fontSize: 24, color: '#7AA8F6' }} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#192877' }}>暂无素材文件</div>
            <div style={{ fontSize: 13, color: '#7F95B2', textAlign: 'center', maxWidth: 320 }}>
              上传参考资料后，AI 将自动结合素材内容生成教材结果。
            </div>
          </div>
        ) : (
          <div
            style={{
              background: '#FFFFFF',
              border: '1px solid #DCE8F8',
              borderRadius: 22,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 84px 104px 92px 88px',
                padding: '12px 18px',
                background: '#F4F9FF',
                borderBottom: '1px solid #DCE8F8',
                fontSize: 11,
                fontWeight: 700,
                color: '#7A93B4',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              <span>文件名</span>
              <span>大小</span>
              <span>状态</span>
              <span>上传时间</span>
              <span style={{ textAlign: 'right' }}>操作</span>
            </div>

            {files.map((file, idx) => (
              <FileRow
                key={file.id}
                file={file}
                isLast={idx === files.length - 1}
                onDelete={handleDelete}
                onReparse={handleReparse}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  isLast,
  onDelete,
  onReparse,
}: {
  file: SourceFile;
  isLast: boolean;
  onDelete: (id: string) => void;
  onReparse: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const icon = fileTypeIcons[file.file_type] ?? <FileUnknownOutlined style={{ fontSize: 16, color: 'var(--gray-400)' }} />;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 84px 104px 92px 88px',
        alignItems: 'center',
        padding: '14px 18px',
        borderBottom: isLast ? 'none' : '1px solid #E8F0FA',
        background: hovered ? '#F4F9FF' : 'transparent',
        transition: 'background var(--transition)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 12,
            flexShrink: 0,
            background: '#F7FAFF',
            border: '1px solid #DCE8F8',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {icon}
        </div>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#192877',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {file.file_name}
        </span>
      </div>

      <span style={{ fontSize: 12, color: '#6B85A8' }}>{formatFileSize(file.file_size)}</span>
      <span><StatusBadge status={file.parse_status} /></span>
      <span style={{ fontSize: 12, color: '#6B85A8' }}>{formatDate(file.uploaded_at)}</span>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
        {file.parse_status === ParseStatus.FAILED && (
          <button
            type="button"
            onClick={() => onReparse(file.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 28,
              padding: '0 10px',
              background: '#FFFFFF',
              border: '1px solid #DCE8F8',
              borderRadius: 10,
              fontSize: 11,
              color: '#1B74F0',
              cursor: 'pointer',
            }}
          >
            <ReloadOutlined style={{ fontSize: 10 }} />
            重试
          </button>
        )}

        <Popconfirm
          title="确认删除"
          description="删除后无法恢复，确定要删除这个文件吗？"
          onConfirm={() => onDelete(file.id)}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          placement="topRight"
        >
          <button
            type="button"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              background: '#FFFFFF',
              border: '1px solid #DCE8F8',
              borderRadius: 10,
              fontSize: 12,
              color: '#8EA1BB',
              cursor: 'pointer',
            }}
          >
            <DeleteOutlined style={{ fontSize: 12 }} />
          </button>
        </Popconfirm>
      </div>
    </div>
  );
}

export default function MaterialsPage() {
  return <MaterialsContent />;
}
