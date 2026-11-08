// Showcase-only substitute for the Host Markdown factory. Fixtures contain
// plain paragraphs; this is not a Markdown compatibility or live Host test.
import React from 'react';
export function MarkdownText({ text }) {
  return <div>{String(text).split('\n\n').map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;
}
