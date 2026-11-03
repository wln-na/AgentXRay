// 「框架」视图的数据模型：每个支持平台一份手工整理的
// Agent 设计与会话存储说明。内容依据 lib/platforms/ 各解析器
// 源码整理（章节内标注了对应的解析器文件）。
import type { Platform } from '@/api/types';

export interface PlatformDoc {
  /** 与 api/types Platform 一致，便于复用平台色标与全局跳转 */
  id: Platform;
  /** 展示名（左侧导航与标题） */
  label: string;
  /** 一句话定位（左侧导航副标题） */
  tagline: string;
  /** 会话根目录（~ 写法），env 覆盖变量见 envVar */
  defaultDir: string;
  /** 存储格式一句话（总览对比表用） */
  storageKind: string;
  /** 子代理机制一句话（总览对比表用） */
  subagents: string;
  /** 续跑/归档一句话（总览对比表用） */
  resume: string;
  /** 目录结构树（代码块，纯文本） */
  dirTree: string;
  /** 文件格式说明（markdown） */
  fileFormat: string;
  /** 消息/事件 schema 说明（markdown） */
  messageSchema: string;
  /** Agent 设计：主/子 agent 与 spawn 机制（markdown） */
  agentDesign: string;
  /** 会话生命周期：id、resume、归档、活跃判定（markdown） */
  lifecycle: string;
  /** 解析器特殊行为清单 */
  special: string[];
  /** 事实来源解析器文件（相对仓库根） */
  source: string;
}
