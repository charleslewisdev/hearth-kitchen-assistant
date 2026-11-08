import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './PrintPortal.module.css';

/**
 * A sheet laid out for paper, which a browser can also save as a PDF. Hidden on screen. Rendered
 * straight into `<body>`, so the print stylesheet can hide everything else there, app chrome
 * included, in one rule. The recipe's Print and the shopping list's Print both use it.
 */
export function PrintPortal({ className, children }: { className?: string; children: ReactNode }) {
  // The print stylesheet hides the rest of <body> only while a sheet is mounted, so printing a
  // screen without one still prints that screen.
  useEffect(() => {
    document.body.setAttribute('data-printing', '');
    return () => document.body.removeAttribute('data-printing');
  }, []);
  return createPortal(
    <article
      className={className ? `${styles.sheet} ${className}` : styles.sheet}
      data-print-sheet=""
      aria-hidden="true"
    >
      {children}
    </article>,
    document.body,
  );
}
