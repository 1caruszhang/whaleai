export interface RichDocSubViewerProps {
  bytes: ArrayBuffer;
  onError: (message: string) => void;
  onEmpty: () => void;
}
