import { Film, ImageIcon, ImagePlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ClipMeta, MediaAsset } from '../../types';
import { filterClips } from '../../lib/clip';
import { listClips, projectMediaIds } from '../../lib/db';
import { pickFiles } from '../../lib/device';
import { ensureThumbs, getThumbStrip, loadAssets, mediaEvents } from '../../lib/media';
import { formatDuration } from '../../lib/util';
import { useEditor } from '../../state/store';
import { addColorClip, importAndInsert, insertLibraryClip, insertMedia } from '../actions';
import { colorName, PALETTE, Sheet } from '../common';

export function MediaSheet({ target, onClose }: { target: 'main' | 'overlay'; onClose: () => void }) {
  const ids = useEditor((s) => (s.project ? projectMediaIds(s.project).join(',') : ''));
  const [assets, setAssets] = useState<MediaAsset[]>([]);

  useEffect(() => {
    let alive = true;
    const list = ids ? ids.split(',') : [];
    void loadAssets(list).then((m) => {
      if (alive) setAssets(list.map((id) => m[id]).filter((a): a is MediaAsset => !!a && a.kind !== 'audio'));
    });
    return () => {
      alive = false;
    };
  }, [ids]);

  const choose = () => {
    // Opens the picker synchronously inside the tap (required on iOS).
    void pickFiles('video/*,image/*').then((files) => {
      if (!files.length) return;
      onClose();
      void importAndInsert(files, target, { autoAspect: target === 'main' });
    });
  };

  const reuse = (a: MediaAsset) => {
    insertMedia([a], target);
    onClose();
  };

  const color = (c: string) => {
    addColorClip(c, target);
    onClose();
  };

  return (
    <Sheet title={target === 'main' ? 'Add media' : 'Add overlay'} onClose={onClose} closeIcon="x">
      <button className="primary-btn block" onClick={choose}>
        <ImagePlus size={20} aria-hidden />
        Choose from device
      </button>
      {target === 'overlay' && <p className="note">Overlays play on top of your main video — picture-in-picture, logos, reactions.</p>}
      {assets.length > 0 && (
        <>
          <h3 className="section-title">In this project</h3>
          <div className="media-grid">
            {assets.map((a) => (
              <Thumb key={a.id} asset={a} onPick={() => reuse(a)} />
            ))}
          </div>
        </>
      )}
      <MyClips target={target} onClose={onClose} />
      <h3 className="section-title">Color clip</h3>
      <div className="swatches" role="group" aria-label="Color clip">
        {PALETTE.map((c) => (
          <button key={c} className="swatch-btn" aria-label={`${colorName(c)} clip`} onClick={() => color(c)}>
            <i style={{ background: c }} />
          </button>
        ))}
      </div>
    </Sheet>
  );
}

interface ClipRow {
  meta: ClipMeta;
  poster: Blob | null;
}

/** Video clips saved in the clip library (newest first). Tap one to add the whole clip. */
function MyClips({ target, onClose }: { target: 'main' | 'overlay'; onClose: () => void }) {
  const [rows, setRows] = useState<ClipRow[]>([]);

  useEffect(() => {
    let alive = true;
    void listClips()
      .then((all) => {
        if (!alive) return;
        const posters = new Map(all.map((r) => [r.meta.id, r.poster]));
        const metas = filterClips(
          all.map((r) => r.meta),
          { folder: 'all', kind: 'video', query: '' },
        );
        setRows(metas.map((meta) => ({ meta, poster: posters.get(meta.id) ?? null })));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!rows.length) return null;
  return (
    <>
      <h3 className="section-title">My clips</h3>
      <div className="media-grid">
        {rows.map((r) => (
          <ClipThumb
            key={r.meta.id}
            row={r}
            onPick={() => {
              onClose();
              void insertLibraryClip(r.meta, target);
            }}
          />
        ))}
      </div>
    </>
  );
}

function ClipThumb({ row, onPick }: { row: ClipRow; onPick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!row.poster) return;
    const u = URL.createObjectURL(row.poster);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [row.poster]);

  return (
    <button className="media-cell" aria-label={`Add ${row.meta.name}`} onClick={onPick}>
      <span className="media-thumb" aria-hidden>
        <Film size={22} />
        {url && <img src={url} alt="" />}
        <small>{formatDuration(row.meta.duration)}</small>
      </span>
      <span className="media-name">{row.meta.name}</span>
    </button>
  );
}

function Thumb({ asset, onPick }: { asset: MediaAsset; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const draw = () => {
      const img = getThumbStrip(asset.id)?.images.find(Boolean);
      const c = ref.current;
      if (!img || !c) return false;
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d')?.drawImage(img, 0, 0);
      return true;
    };
    if (draw()) return;
    const onUpdate = (e: Event) => {
      if ((e as CustomEvent<string>).detail === asset.id) draw();
    };
    mediaEvents.addEventListener('update', onUpdate);
    void ensureThumbs(asset.id);
    return () => mediaEvents.removeEventListener('update', onUpdate);
  }, [asset.id]);

  const Icon = asset.kind === 'video' ? Film : ImageIcon;
  return (
    <button className="media-thumb" aria-label={`Add ${asset.name}`} onClick={onPick}>
      <Icon size={22} aria-hidden />
      <canvas ref={ref} aria-hidden />
      {asset.kind === 'video' && <small>{formatDuration(asset.duration)}</small>}
    </button>
  );
}
