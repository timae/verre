import { useState } from 'react';
import { Pressable } from 'react-native';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';

// Line-clamped text with an inline more/less toggle (the design's `.ir-clamp`).
// An invisible measurer lays out the full text, and its `onTextLayout` line
// boxes drive a word-boundary cut so the clamped copy ends cleanly. Extracted
// from the moments impression detail (02e) so the feed impression detail shares
// ONE clamp behaviour (was a pending extraction in apps/mobile/CLAUDE.md).
// `medium` = the `.ir-ival` 500-weight ink variant (grape/vinification values);
// default = the `.ir-desc` 400-weight ink-soft body (descriptions).
export function ClampText({ text, lines, medium }: { text: string; lines: number; medium?: boolean }) {
  const phone = usePhoneTokens();
  const [open, setOpen] = useState(false);
  const [clampLen, setClampLen] = useState<number | null>(null);
  const family = medium ? 'InstrumentSans_500Medium' : undefined;
  let truncated: string | null = null;
  if (clampLen !== null) {
    let txt = text.slice(0, clampLen).replace(/\s+$/, '');
    let cut = txt.lastIndexOf(' ');
    while (cut > 0 && txt.length - cut < 9) cut = txt.lastIndexOf(' ', cut - 1);
    if (cut > 0) txt = txt.slice(0, cut);
    truncated = txt.replace(/[\s,.;:]+$/, '') + ' …';
  }
  return (
    <Pressable onPress={() => setOpen((o) => !o)} disabled={truncated === null && !open}>
      <VText
        variant="small"
        pointerEvents="none"
        onTextLayout={(e) => {
          const laid = e.nativeEvent.lines;
          setClampLen(
            laid.length > lines ? laid.slice(0, lines).reduce((n, l) => n + l.text.length, 0) : null,
          );
        }}
        style={{ position: 'absolute', left: 0, right: 0, opacity: 0, ...phone.text('small'), fontFamily: family }}
      >
        {text}
      </VText>
      <VText
        variant="small"
        color={medium ? 'ink' : 'inkSoft'}
        numberOfLines={open ? undefined : lines}
        style={{ ...phone.text('small'), fontFamily: family }}
      >
        {open ? text : truncated ?? text}
        {truncated !== null ? (
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }} color="accent">
            {open ? '  less' : ' more'}
          </VText>
        ) : null}
      </VText>
    </Pressable>
  );
}
