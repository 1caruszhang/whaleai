import type React from 'react';

export interface ImageAttachment {
  id: string;
  file: File;
  preview: string;
  source?: 'inline_base64' | 'attachment_ref';
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  relativePath?: string;
}

/** 输入框里的会话文件 chip；发送时序列化为 @token 并随结构化 files 载荷传出。 */
export interface SessionFileRef {
  id: string;
  /** 工作区相对路径：`xiaojing_files/<sessionId>/<name>` */
  referencePath: string;
  name: string;
}

export interface SimpleChatInputProps {
  value?: string;
  onChange?: (value: string) => void;
  onSend: (
    text: string,
    images?: ImageAttachment[],
    files?: SessionFileRef[],
  ) => boolean | void | Promise<boolean | void>;
  onStop?: () => void;
  isLoading: boolean;
  sendBlocked?: boolean;
  workspacePath?: string | null;
  sessionId?: string | null;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export interface SimpleChatInputHandle {
  processDroppedFiles: (files: File[]) => Promise<void>;
  processDroppedFilePaths: (paths: string[]) => Promise<void>;
  insertReferences: (paths: string[]) => void;
  appendReferenceToken: (token: string) => void;
  setValue: (value: string) => void;
  setImages: (images: ImageAttachment[]) => void;
  focus: () => void;
  clearWorkspaceBoundDraft: () => { strippedReferences: number; clearedImages: number };
  getCurrentValue: () => string;
  getImages: () => ImageAttachment[];
  getSessionFiles: () => SessionFileRef[];
}
