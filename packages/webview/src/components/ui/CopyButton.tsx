import React, { useState, useCallback, useRef } from 'react';
import { cn } from '../../theme';

/** CopyButton size variants. */
export type CopyButtonSize = 'sm' | 'md';

/** CopyButton component props. */
export interface CopyButtonProps {
  /** The text to copy to the clipboard. */
  text: string;
  /** Optional visible label. Defaults to "Copy". */
  label?: string;
  size?: CopyButtonSize;
  className?: string;
}

const sizeClasses: Record<CopyButtonSize, string> = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-1 text-xs',
};

/** Button that copies text to the clipboard and shows a confirmation. */
export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  label = 'Copy',
  size = 'md',
  className,
}) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, 2000);
  }, [text]);

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      className={cn(
        'inline-flex items-center gap-1 rounded font-medium transition-colors',
        'bg-[var(--vscode-button-secondaryBackground,#3a3d41)]',
        'text-[var(--vscode-button-secondaryForeground,#cccccc)]',
        'hover:bg-[var(--vscode-button-secondaryHoverBackground,#45494e)]',
        sizeClasses[size],
        className,
      )}
      onClick={handleCopy}
    >
      {copied ? (
        <>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Copied!
        </>
      ) : (
        <>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
          {label}
        </>
      )}
    </button>
  );
};
