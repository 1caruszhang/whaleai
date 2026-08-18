import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { FileText, Paperclip, Send, Square, X } from 'lucide-react';

import { useToast } from '@/components/Toast';
import { useUndoStack } from '@/hooks/useUndoStack';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import {
  buildSessionFileToken,
  extractSessionFileReferences,
} from '@/../shared/sessionFileReference';
import { imageAttachmentName } from './attachmentNames';
import { useAttachmentHandling } from './hooks/useAttachmentHandling';
import type { ImageAttachment, SimpleChatInputHandle, SimpleChatInputProps } from './types';

const SimpleChatInput = memo(forwardRef<SimpleChatInputHandle, SimpleChatInputProps>(
  function SimpleChatInput({
    value,
    onChange,
    onSend,
    onStop,
    isLoading,
    sendBlocked = false,
    workspacePath,
    sessionId,
  }, ref) {
    const toast = useToast();
    const toastRef = useRef(toast);
    const [internalValue, setInternalValue] = useState(value ?? '');
    const [, setShowPlusMenu] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const inputValue = value ?? internalValue;
    const inputValueRef = useRef(inputValue);
    const fileService = useWorkspaceFileService(workspacePath ?? null);
    const undoStack = useUndoStack();

    useEffect(() => {
      toastRef.current = toast;
      inputValueRef.current = inputValue;
    }, [inputValue, toast]);

    const setValue = useCallback((next: string) => {
      inputValueRef.current = next;
      setInternalValue(next);
      onChange?.(next);
    }, [onChange]);

    const {
      images,
      setImages,
      removeImage,
      fileRefs,
      removeFileRef,
      clearFileRefs,
      processDroppedFiles,
      processDroppedFilePaths,
      handleUploadButtonClick,
      handleFileChange,
      handlePaste,
    } = useAttachmentHandling({
      fileService,
      workspacePath,
      // The Xiaojing main Agent owns image admission server-side. Avoid a
      // renderer-side generic provider/model selector becoming a second owner.
      attachmentSessionId: sessionId,
      inputValueRef,
      textareaRef,
      fileInputRef,
      toastRef,
      undoStack,
      setInputValue: (next) => {
        const resolved = typeof next === 'function' ? next(inputValueRef.current) : next;
        setValue(resolved);
      },
      setShowPlusMenu,
    });

    const insertReferences = useCallback((paths: string[]) => {
      if (paths.length === 0) return;
      const next = `${inputValueRef.current}${inputValueRef.current ? ' ' : ''}${paths.map((path) => `@${path}`).join(' ')} `;
      setValue(next);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }, [setValue]);

    const appendReferenceToken = useCallback((token: string) => {
      const trimmed = token.trim();
      if (!trimmed) return;
      setValue(`${inputValueRef.current}${inputValueRef.current ? ' ' : ''}${trimmed} `);
    }, [setValue]);

    const clearWorkspaceBoundDraft = useCallback(() => {
      const { cleanText, references } = extractSessionFileReferences(inputValueRef.current);
      const clearedImages = images.length;
      setValue(cleanText);
      setImages([]);
      const clearedFileRefs = clearFileRefs();
      return { strippedReferences: references.length + clearedFileRefs, clearedImages };
    }, [images.length, setImages, setValue, clearFileRefs]);

    useImperativeHandle(ref, () => ({
      processDroppedFiles,
      processDroppedFilePaths,
      insertReferences,
      appendReferenceToken,
      setValue,
      setImages,
      focus: () => textareaRef.current?.focus(),
      clearWorkspaceBoundDraft,
      getCurrentValue: () => inputValueRef.current,
      getImages: () => images,
      getSessionFiles: () => fileRefs,
    }), [appendReferenceToken, clearWorkspaceBoundDraft, fileRefs, images, insertReferences, processDroppedFilePaths, processDroppedFiles, setImages, setValue]);

    const submit = useCallback(async () => {
      const text = inputValueRef.current.trim();
      const hasSessionFiles = fileRefs.length > 0;
      if (sendBlocked || isLoading || (!text && images.length === 0 && !hasSessionFiles)) return;
      // 会话文件以 @token 拼进消息文本（transcript 持久化契约），同时把结构化
      // 列表交给 onSend，供服务端构建附件提醒；渲染端显示时再剥离 token。
      const textWithTokens = hasSessionFiles
        ? [text, ...fileRefs.map((ref) => buildSessionFileToken(ref.referencePath))]
          .filter(Boolean)
          .join(' ')
        : text;
      const accepted = await onSend(textWithTokens, images, hasSessionFiles ? fileRefs : undefined);
      if (accepted === false) return;
      setValue('');
      setImages([]);
      clearFileRefs();
    }, [clearFileRefs, fileRefs, images, isLoading, onSend, sendBlocked, setImages, setValue]);

    return (
      <div
        className="border-t border-[var(--line)] bg-[var(--paper)] px-4 py-3"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const files = Array.from(event.dataTransfer.files);
          if (files.length > 0) void processDroppedFiles(files);
        }}
      >
        <div className="mx-auto max-w-3xl rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-sm focus-within:border-[var(--focus-border)]">
          {images.length > 0 && (
            <div className="flex gap-2 overflow-x-auto px-1 pb-2">
              {images.map((image: ImageAttachment) => (
                <div key={image.id} className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper)]">
                  <img src={image.preview} alt={imageAttachmentName(image)} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    aria-label="移除附件"
                    onClick={() => removeImage(image.id)}
                    className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {fileRefs.length > 0 && (
            <div className="flex gap-2 overflow-x-auto px-1 pb-2" data-testid="session-file-refs">
              {fileRefs.map((ref) => (
                <div
                  key={ref.id}
                  title={ref.referencePath}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-xs text-[var(--ink)]"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                  <span className="max-w-[160px] truncate">{ref.name}</span>
                  <button
                    type="button"
                    aria-label="移除文件"
                    onClick={() => removeFileRef(ref.id)}
                    className="rounded-full p-0.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={inputValue}
            rows={2}
            placeholder="告诉小鲸你想完成的 GEO 工作…"
            onChange={(event) => setValue(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            className="max-h-48 min-h-14 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
          />
          <div className="flex items-center justify-between px-1 pt-1">
            <button
              type="button"
              aria-label="添加附件"
              onClick={() => void handleUploadButtonClick()}
              className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            {isLoading ? (
              <button
                type="button"
                aria-label="停止生成"
                onClick={onStop}
                className="rounded-xl bg-[var(--ink)] p-2 text-[var(--paper)]"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="发送"
                disabled={sendBlocked || (!inputValue.trim() && images.length === 0 && fileRefs.length === 0)}
                onClick={() => void submit()}
                className="rounded-xl bg-[var(--button-primary-bg)] p-2 text-[var(--button-primary-text)] disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileChange} />
      </div>
    );
  },
));

export default SimpleChatInput;
