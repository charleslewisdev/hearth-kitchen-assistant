import { useEffect, useRef, useState } from 'react';
import { trpc } from '../lib/trpc';
import { toBase64 } from '../lib/image-upload';
import { fileUrl, prepareImage, UnreadableImageError } from '../lib/photo-upload';
import styles from './RecipePhotos.module.css';

/** One of a recipe's files, as `recipe.get` returns it. */
export interface RecipeFileRef {
  id: string;
  kind: 'photo' | 'source_page' | 'source_pdf';
  width: number | null;
  height: number | null;
  position: number;
}

/** Upload one photo the cook picked. Resized and stripped of EXIF in the browser first. */
export function usePhotoUpload(recipeId: string) {
  const utils = trpc.useUtils();
  const upload = trpc.recipeFile.upload.useMutation();
  const [busy, setBusy] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  async function addPhotos(files: File[], cookLogId?: string) {
    setProblem(null);
    setBusy(files.length);
    let unreadable = 0;
    let failed = 0;
    for (const file of files) {
      try {
        const prepared = await prepareImage(file);
        await upload.mutateAsync({
          recipeId,
          kind: 'photo',
          fullBase64: await toBase64(prepared.full),
          thumbBase64: await toBase64(prepared.thumb),
          width: prepared.width,
          height: prepared.height,
          ...(cookLogId ? { cookLogId } : {}),
        });
      } catch (err) {
        if (err instanceof UnreadableImageError) unreadable++;
        else failed++;
      }
      setBusy((n) => n - 1);
    }
    setBusy(0);
    await Promise.all([
      utils.recipe.get.invalidate(),
      utils.recipe.list.invalidate(),
      utils.cookLog.list.invalidate(),
    ]);
    if (unreadable > 0) {
      setProblem(
        'This browser couldn’t open that photo format. Try a JPEG, or add it from your phone.',
      );
    } else if (failed > 0) {
      setProblem(
        `Couldn’t add ${failed === 1 ? 'a photo' : `${failed} photos`}. Please try again.`,
      );
    }
  }

  return { addPhotos, busy, problem };
}

/**
 * A full-size look at one file, with what can be done to it. An in-page dialog rather than a
 * browser one, and Escape closes it. Left and right step through the same group.
 */
function Viewer({
  files,
  index,
  coverFileId,
  onIndex,
  onClose,
  onMakeCover,
  onDelete,
}: {
  files: RecipeFileRef[];
  index: number;
  coverFileId: string | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  onMakeCover: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const file = files[index]!;
  const [confirming, setConfirming] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  useEffect(() => setConfirming(false), [index]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && index < files.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, files.length, onClose, onIndex]);

  const label = file.kind === 'photo' ? 'Photo' : 'Source page';
  return (
    <div className={styles.viewer} role="dialog" aria-modal="true" aria-label={label}>
      <div className={styles.viewerBar}>
        <span className={styles.viewerCount}>
          {index + 1} of {files.length}
        </span>
        <button type="button" ref={closeRef} className={styles.viewerButton} onClick={onClose}>
          Close
        </button>
      </div>
      <div className={styles.viewerStage}>
        {index > 0 && (
          <button
            type="button"
            className={`${styles.step} ${styles.stepLeft}`}
            onClick={() => onIndex(index - 1)}
            aria-label="Previous"
          >
            ‹
          </button>
        )}
        <img className={styles.viewerImage} src={fileUrl(file.id, 'full')} alt={label} />
        {index < files.length - 1 && (
          <button
            type="button"
            className={`${styles.step} ${styles.stepRight}`}
            onClick={() => onIndex(index + 1)}
            aria-label="Next"
          >
            ›
          </button>
        )}
      </div>
      <div className={styles.viewerActions}>
        {file.kind === 'photo' &&
          (file.id === coverFileId ? (
            <span className={styles.coverNote}>Cover photo</span>
          ) : (
            <button
              type="button"
              className={styles.viewerButton}
              onClick={() => onMakeCover(file.id)}
            >
              Make cover
            </button>
          ))}
        {confirming ? (
          <span className={styles.confirm} role="group" aria-label="Confirm delete">
            Delete this {file.kind === 'photo' ? 'photo' : 'page'}?
            <button
              type="button"
              className={styles.viewerButton}
              onClick={() => setConfirming(false)}
            >
              Keep
            </button>
            <button type="button" className={styles.danger} onClick={() => onDelete(file.id)}>
              Yes, delete
            </button>
          </span>
        ) : (
          <button type="button" className={styles.viewerButton} onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The recipe's photos and the pages it was imported from: add, look, pick the cover, delete.
 * The cover itself is drawn at the top of the recipe screen; this is the rest.
 */
export function RecipePhotos({
  recipeId,
  recipeTitle,
  files,
  coverFileId,
}: {
  recipeId: string;
  recipeTitle: string;
  files: RecipeFileRef[];
  coverFileId: string | null;
}) {
  const utils = trpc.useUtils();
  const refresh = () =>
    Promise.all([utils.recipe.get.invalidate(), utils.recipe.list.invalidate()]);
  const remove = trpc.recipeFile.remove.useMutation({ onSuccess: refresh });
  const setCover = trpc.recipeFile.setCover.useMutation({ onSuccess: refresh });
  const { addPhotos, busy, problem } = usePhotoUpload(recipeId);
  const [open, setOpen] = useState<{ group: 'photo' | 'source'; index: number } | null>(null);

  const photos = files.filter((f) => f.kind === 'photo');
  const pages = files.filter((f) => f.kind === 'source_page');
  const pdf = files.find((f) => f.kind === 'source_pdf');
  const group = open?.group === 'source' ? pages : photos;

  return (
    <section className={styles.section} aria-label="Photos">
      <div className={styles.head}>
        <h2 className={styles.heading}>Photos</h2>
        <label className={styles.addButton}>
          {busy > 0 ? `Adding ${busy}…` : '+ Add photos'}
          <input
            type="file"
            accept="image/*"
            multiple
            className={styles.fileInput}
            disabled={busy > 0}
            onChange={(e) => {
              const chosen = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (chosen.length > 0) void addPhotos(chosen);
            }}
          />
        </label>
      </div>
      {photos.length === 0 ? (
        <p className={styles.empty}>No photos yet. The first one you add becomes the cover.</p>
      ) : (
        <ul className={styles.strip}>
          {photos.map((file, index) => (
            <li key={file.id}>
              <button
                type="button"
                className={styles.thumbButton}
                onClick={() => setOpen({ group: 'photo', index })}
                aria-label={`Photo ${index + 1} of ${recipeTitle}${file.id === coverFileId ? ', the cover' : ''}`}
              >
                <img
                  className={styles.thumb}
                  src={fileUrl(file.id, 'thumb')}
                  alt=""
                  loading="lazy"
                />
                {file.id === coverFileId && <span className={styles.coverBadge}>Cover</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}

      {(pages.length > 0 || pdf) && (
        <>
          <h3 className={styles.subheading}>Source pages</h3>
          <p className={styles.empty}>What this recipe was imported from.</p>
          <ul className={styles.strip}>
            {pages.map((file, index) => (
              <li key={file.id}>
                <button
                  type="button"
                  className={styles.thumbButton}
                  onClick={() => setOpen({ group: 'source', index })}
                  aria-label={`Source page ${index + 1}`}
                >
                  <img
                    className={styles.page}
                    src={fileUrl(file.id, 'thumb')}
                    alt=""
                    loading="lazy"
                  />
                </button>
              </li>
            ))}
          </ul>
          {pdf && (
            <p className={styles.pdfRow}>
              <a href={fileUrl(pdf.id, 'full')} className={styles.pdfLink} download>
                Download the original PDF
              </a>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => remove.mutate({ id: pdf.id })}
              >
                Delete it
              </button>
            </p>
          )}
        </>
      )}

      {open && group[open.index] && (
        <Viewer
          files={group}
          index={open.index}
          coverFileId={coverFileId}
          onIndex={(index) => setOpen({ ...open, index })}
          onClose={() => setOpen(null)}
          onMakeCover={(fileId) => setCover.mutate({ recipeId, fileId })}
          onDelete={(id) => {
            remove.mutate({ id });
            setOpen(null);
          }}
        />
      )}
    </section>
  );
}
