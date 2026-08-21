import React from 'react';
import useFileDrop from '../lib/useFileDrop.js';

/* MAKE ANY UPLOAD CONTROL ACCEPT A DRAGGED FILE — one line per zone.

   Owner-reported 2026-08-21 (item 6): "A lot of the uploads are missing the drag and
   drop option. You can only click and upload… Please dig in."

   `useFileDrop` already existed and is the right mechanism; what was missing was a way
   to APPLY it without hand-rolling four props at every site, and — the part that
   actually blocked the sweep — a way to use it INSIDE A .map(). React forbids a hook in
   a loop, which is why every existing per-row zone is a hand-rolled copy. A COMPONENT
   has no such limit: each rendered <DropZone> is its own instance with its own hook.

   It adds no markup of its own beyond one element, takes the highlight class the host
   already uses, and never changes how the CLICK path works — the button or label inside
   it keeps doing exactly what it did.

   `onFiles` receives File[]; every upload path in this app takes
   {filename, contentType, dataBase64}, so a caller just maps them as it already does
   for its <input>. `drop-files.js` explains an unreadable drop to the user itself, so a
   caller never has to. */
export default function DropZone({
  onFiles,
  enabled = true,
  className = '',
  overClass = 'drop-over',
  as: Tag = 'div',
  title,
  children,
  ...rest
}) {
  const { over, dropProps } = useFileDrop(onFiles, enabled);
  return (
    <Tag
      className={`${className}${over && enabled ? ` ${overClass}` : ''}`}
      title={title}
      {...dropProps}
      {...rest}
    >
      {children}
    </Tag>
  );
}
