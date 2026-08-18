export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestion {
  id?: string;
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
  required?: boolean;
  isSecret?: boolean;
}

export interface AskUserQuestionRequest {
  requestId: string;
  sessionId?: string | null;
  questions: AskUserQuestion[];
  previewFormat?: 'html' | 'markdown';
}
