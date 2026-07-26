'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppstoreOutlined, FolderOpenOutlined, PlusOutlined, SearchOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { Dropdown, Modal, Spin, message } from 'antd';
import AppShell from '@/components/layout/AppShell';
import CreateProjectModal from '@/components/project/CreateProjectModal';
import ProjectCard from '@/components/project/ProjectCard';
import { projectService } from '@/services/projectService';
import { useProjectStore } from '@/stores/projectStore';
import type { Project } from '@/types';

type ViewMode = 'grid' | 'list';

function SearchBox({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <label className={`projects-search ${className ?? ''}`.trim()}>
      <SearchOutlined />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </label>
  );
}

function ProjectListContent() {
  const router = useRouter();
  const { projects, setProjects } = useProjectStore();
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  const fetchProjects = useCallback(async () => {
    try {
      setLoading(true);
      const res = await projectService.listProjects({ page: 1, page_size: 100 });

      if (res.success) {
        const sorted = [...res.data.items].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        );
        setProjects(sorted);
      }
    } catch {
      message.error('加载教材列表失败');
    } finally {
      setLoading(false);
    }
  }, [setProjects]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const filteredProjects = useMemo(
    () => projects.filter((project: Project) => project.name.toLowerCase().includes(search.toLowerCase())),
    [projects, search],
  );

  const handleDelete = (id: string) => {
    Modal.confirm({
      title: '确认删除',
      content: '删除后无法恢复，确定要删除这个教材吗？',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await projectService.deleteProject(id);

          if (res.success) {
            message.success('教材已删除');
            setProjects(projects.filter((project) => project.id !== id));
          } else {
            message.error(res.message ?? '删除失败');
          }
        } catch {
          message.error('删除教材失败');
        }
      },
    });
  };

  return (
    <AppShell
      activeNav="projects"
      title="灵思睿著"
      subtitle="围绕课程、资料与章节任务统一管理教材项目。"
    >
      <div className="projects-header-row">
        <div>
          <div className="projects-section-kicker">Project Center</div>
          <div className="projects-section-title">
            <h2>我的教材</h2>
            {!loading && <span>{filteredProjects.length} 个项目</span>}
          </div>
        </div>

        <div className="projects-summary-badge">
          <span className="projects-summary-dot" />
          最近更新按时间排序
        </div>
      </div>

      <div className="projects-toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="搜索当前项目列表..."
          className="projects-toolbar-search"
        />

        <div className="projects-toolbar-actions">
          <div className="projects-view-switch">
            {(['grid', 'list'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={viewMode === mode ? 'active' : ''}
              >
                {mode === 'grid' ? <AppstoreOutlined /> : <UnorderedListOutlined />}
              </button>
            ))}
          </div>

          <button type="button" className="projects-create-btn btn-shimmer btn-create-glow" onClick={() => setCreateOpen(true)}>
            <PlusOutlined />
            新建教材
          </button>
        </div>
      </div>

      <div className="projects-board">
        {loading ? (
          <div className="projects-empty">
            <Spin size="large" />
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="projects-empty">
            <div className="projects-empty-icon">
              <FolderOpenOutlined />
            </div>
            <h3>{search ? '没有匹配的教材' : '还没有教材项目'}</h3>
            <p>{search ? '换个关键词试试。' : '创建第一本教材，开始搭建你的写作工作台。'}</p>
            {!search && (
              <button type="button" className="projects-create-btn" onClick={() => setCreateOpen(true)}>
                <PlusOutlined />
                新建教材
              </button>
            )}
          </div>
        ) : viewMode === 'grid' ? (
          <div className="projects-grid">
            {filteredProjects.map((project, index) => (
              <ProjectCard key={project.id} project={project} onDelete={handleDelete} index={index} />
            ))}
          </div>
        ) : (
          <div className="projects-list-panel">
            <div className="projects-list-header">
              <span>教材名称</span>
              <span>状态</span>
              <span>更新时间</span>
              <span />
            </div>

            {filteredProjects.map((project, index) => (
              <ProjectCard key={project.id} project={project} onDelete={handleDelete} index={index} listMode />
            ))}
          </div>
        )}
      </div>

      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          fetchProjects();
        }}
      />
    </AppShell>
  );
}

export default function ProjectsPage() {
  return <ProjectListContent />;
}
