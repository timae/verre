import { Host, Picker, Text as SwiftText } from '@expo/ui/swift-ui';
import { accessibilityLabel, clipped, frame, labelsHidden, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ActionSheetIOS, Alert, Image, Keyboard, Platform, Pressable, View, useWindowDimensions, type TextInputInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BarTitle } from '@/components/VBar';
import { DatePickerSheet, nextFullHour, pickPhoto, pickPhotoOrRemove, type PickedPhoto } from '@/components/moments/momentForm';
import { Icon } from '@/components/ui/Icon';
import { EditBar, InlineField, LongPressable, editTouchHandlers, markNoShake } from '@/components/ui/InPlaceEdit';
import { VText } from '@/components/ui/VText';
import { updateMomentSettings, type MomentSettingsBody, type MomentSettingsEcho, type SessionMetaView, type SessionState } from '@/lib/api/sessions';
import { errorText } from '@/lib/errorCopy';
import { usePhoneTokens } from '@/lib/layout';
import { viewerCacheEpoch } from '@/lib/query';
import { popSheet, pushSheet } from '@/lib/sheetVisibility';
import { useTheme } from '@/theme';

// A moment's top, edited in place by its hosts (2026-11-14, Simon: "like on
// the profile", the design unchanged). Touch and hold the name (on the cover,
// or in the bar without one), the address, the event link or the description:
// every detail on screen becomes a field where it is, the held one focused,
// and the profile's edit bar rides the keyboard. Holding the date opens the
// date picker (with an end time: Change Start / Change End / Remove End Time
// first). Holding the cover changes it at once (Take Photo / Choose from
// Library / Remove Cover), like the profile's. Empty details stay hidden (an
// empty description shows its hosts the bio's "Touch and hold to add …"
// prompt), the rest are added from the bar: its "Add Fields" turns into the
// iPhone's own wheel (a native picker:
// clicks and snapping are the OS's), Cancel leaves the wheel, Done reads
// "Add". The rest of the screen dims and goes inert in place; a tap there
// shakes the bar. Done = ONE settings PATCH of what changed against the
// values the edit started from (a cohost's edit to a detail you didn't touch
// survives), its echo merged into the poll's cache so the new text shows at
// once. Leaving the screen cancels. Host + cohosts only (the server's
// `isHostByIdentity`); Moment Details stays the full form.

export type MomentTextField = 'name' | 'address' | 'link' | 'description';
type DetailField = Exclude<MomentTextField, 'name'>;
export type MomentAddKey = 'cover' | 'start' | 'end' | DetailField;

export type MomentDraft = {
  name: string;
  address: string;
  link: string;
  description: string;
  dateFrom: Date | null;
  dateTo: Date | null;
  /** A cover picked from Add Fields: shown at once, uploaded with Done. */
  cover: PickedPhoto | null;
  /** The optional details on screen while editing: set ones + the ones added. */
  shown: Record<DetailField, boolean>;
};

// The server's caps (lib/sessionFields.ts slices to these).
export const MOMENT_FIELD_MAX: Record<MomentTextField, number> = { name: 80, address: 255, link: 512, description: 1000 };
export const MOMENT_EDIT_HINT = 'Double-tap and hold to edit the moment.';

type Seed = { name: string; address: string; link: string; description: string; from: number | null; to: number | null };
const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};
const HOUR = 3600_000;

export type MomentEditApi = ReturnType<typeof useMomentEdit>;

export function useMomentEdit({ code, meta, stateKey, canEdit, scrollBy }: {
  code: string;
  meta: SessionMetaView | null;
  stateKey: readonly unknown[];
  canEdit: boolean;
  /** Scrolls the moment's list by `dy` (each layout installs its own). */
  scrollBy: RefObject<((dy: number) => void) | null>;
}) {
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  const [draft, setDraft] = useState<MomentDraft | null>(null);
  const [seed, setSeed] = useState<Seed | null>(null);
  const [focus, setFocus] = useState<MomentTextField | null>(null);
  const [focusedField, setFocusedField] = useState<MomentTextField | null>(null);
  const [saving, setSaving] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState<MomentAddKey | null>(null);
  const [datePick, setDatePick] = useState<{ which: 'from' | 'to'; value: Date } | null>(null);
  const nameRef = useRef<TextInputInstance | null>(null);
  const addressRef = useRef<TextInputInstance | null>(null);
  const linkRef = useRef<TextInputInstance | null>(null);
  const descriptionRef = useRef<TextInputInstance | null>(null);
  const refs = { name: nameRef, address: addressRef, link: linkRef, description: descriptionRef };
  const editing = draft != null;
  const editingRef = useRef(false);
  editingRef.current = editing;
  // While Done's PATCH is out the fields take no typing: the save sent a
  // snapshot, and its success ends the edit (a later keystroke would be lost).
  const savingRef = useRef(false);
  savingRef.current = saving;

  const cancel = useCallback(() => {
    Keyboard.dismiss();
    setDraft(null);
    setSeed(null);
    setFocus(null);
    setFocusedField(null);
    setAdding(false);
    setDatePick(null);
  }, []);
  // The pill stays hidden for the whole edit (the profile's one ref-counted hold).
  useEffect(() => {
    if (!editing) return;
    pushSheet();
    return popSheet;
  }, [editing]);
  // Leaving the screen (a push, a tab switch) cancels; so does losing the host
  // role mid-edit (the save would only be refused).
  useFocusEffect(
    useCallback(
      () => () => {
        if (editingRef.current) cancel();
      },
      [cancel],
    ),
  );
  useEffect(() => {
    if (!canEdit && editingRef.current) cancel();
  }, [canEdit, cancel]);

  // Seeded, then clamped into the picker's window (the OS would snap it).
  const openDate = (which: 'from' | 'to', d: MomentDraft) => {
    let value = which === 'from' ? d.dateFrom ?? nextFullHour() : d.dateTo ?? new Date((d.dateFrom ?? nextFullHour()).getTime() + 6 * HOUR);
    if (which === 'from' && d.dateTo && value > d.dateTo) value = d.dateTo;
    if (which === 'to' && d.dateFrom && value < d.dateFrom) value = d.dateFrom;
    Keyboard.dismiss();
    setDatePick({ which, value });
  };
  const chooseDate = (d: MomentDraft) => {
    if (!d.dateFrom || !d.dateTo || Platform.OS !== 'ios') {
      openDate('from', d);
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Change Start', 'Change End', 'Remove End Time', 'Cancel'], cancelButtonIndex: 3, destructiveButtonIndex: 2 },
      (i) => {
        if (i === 0) openDate('from', d);
        else if (i === 1) openDate('to', d);
        else if (i === 2) setDraft((x) => (x ? { ...x, dateTo: null } : x));
      },
    );
  };

  const start = (field: MomentTextField | 'when') => {
    if (!meta || !canEdit || saving || coverBusy) return;
    if (draft) {
      if (field === 'when') chooseDate(draft);
      else refs[field].current?.focus();
      return;
    }
    const d: MomentDraft = {
      name: meta.name ?? '',
      address: meta.address ?? '',
      link: meta.link ?? '',
      description: meta.description ?? '',
      dateFrom: ms(meta.dateFrom) != null ? new Date(ms(meta.dateFrom)!) : null,
      dateTo: ms(meta.dateTo) != null ? new Date(ms(meta.dateTo)!) : null,
      cover: null,
      // The held line is shown even while empty (the description's prompt).
      shown: { address: !!meta.address || field === 'address', link: !!meta.link || field === 'link', description: !!meta.description || field === 'description' },
    };
    setSeed({ name: d.name, address: d.address, link: d.link, description: d.description, from: ms(meta.dateFrom), to: ms(meta.dateTo) });
    setDraft(d);
    setFocus(field === 'when' ? null : field);
    if (field === 'when') chooseDate(d);
  };

  // The echo (the server's scrubbed, cleaned values and the new cover URL)
  // into the poll's cache: the edit ends on the saved text, never a flash of
  // the old one before the refetch. A new cover is fetched first (bounded), so
  // the photo doesn't blank out between the local preview and the upload.
  const applyEcho = async (echo: MomentSettingsEcho | null, epoch: number, fetchCover: boolean) => {
    if (echo?.coverPhotoUrl && fetchCover) {
      await Promise.race([Image.prefetch(echo.coverPhotoUrl).catch(() => false), new Promise((r) => setTimeout(r, 1500))]);
    }
    await queryClient.cancelQueries({ queryKey: stateKey });
    if (viewerCacheEpoch() !== epoch) return false;
    if (echo) {
      // Merged into the cached meta, or (a degraded poll left it null while
      // the screen still shows its last good one) into the meta on screen.
      queryClient.setQueryData<SessionState>(stateKey, (prev) => {
        const base = prev ? prev.meta ?? meta : null;
        return prev && base
          ? {
              ...prev,
              meta: {
                ...base,
                name: echo.name,
                address: echo.address,
                dateFrom: echo.dateFrom,
                dateTo: echo.dateTo,
                timezone: echo.timezone,
                description: echo.description,
                link: echo.link,
                coverPhotoUrl: echo.coverPhotoUrl,
              },
            }
          : prev;
      });
    }
    void queryClient.invalidateQueries({ queryKey: ['session-state', code] });
    void queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
    return true;
  };

  const done = async () => {
    if (!draft || !seed || saving) return;
    // Moment Details' rules (the required name + start date, root CLAUDE.md).
    const name = draft.name.trim();
    if (!name) return void Alert.alert('Couldn’t Save', 'Please name your moment.');
    if (!draft.dateFrom) return void Alert.alert('Couldn’t Save', 'Please set a start date.');
    if (draft.dateTo && draft.dateTo < draft.dateFrom) return void Alert.alert('Couldn’t Save', 'The end time can’t be before the start time.');
    const body: MomentSettingsBody = {};
    if (name !== seed.name) body.name = name;
    for (const f of ['address', 'link', 'description'] as const) {
      const v = draft[f].trim();
      if (v !== seed[f]) body[f] = v;
    }
    if (draft.dateFrom.getTime() !== seed.from) body.dateFrom = draft.dateFrom.toISOString();
    if ((draft.dateTo?.getTime() ?? null) !== seed.to) body.dateTo = draft.dateTo ? draft.dateTo.toISOString() : null;
    if (body.dateFrom !== undefined || body.dateTo !== undefined) body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (draft.cover) body.coverPhoto = draft.cover.dataUrl;
    if (Object.keys(body).length === 0) return cancel();
    savingRef.current = true;
    setSaving(true);
    const epoch = viewerCacheEpoch();
    try {
      const echo = await updateMomentSettings(code, body);
      if (viewerCacheEpoch() !== epoch) return;
      if (await applyEcho(echo, epoch, !!draft.cover)) cancel();
    } catch (e) {
      if (viewerCacheEpoch() !== epoch) return;
      Alert.alert('Couldn’t Save', errorText(e));
    } finally {
      setSaving(false);
    }
  };

  // Hold the cover (not while editing): changed at once, like the profile's.
  const changeCover = async () => {
    if (!meta || !canEdit || draft || coverBusy || saving) return;
    // 🔒 The viewer the hold was for: an account switch while the picker is
    // open must not send this moment's change with the new account's cookie.
    const epoch = viewerCacheEpoch();
    const picked = await pickPhotoOrRemove(meta.coverPhotoUrl ? 'Remove Cover' : null);
    if (!picked || viewerCacheEpoch() !== epoch) return;
    if (picked !== 'remove' && 'failed' in picked) return void Alert.alert('Couldn’t Use That Photo', 'Try another photo.');
    setCoverBusy(true);
    try {
      const echo = await updateMomentSettings(code, { coverPhoto: picked === 'remove' ? null : picked.dataUrl });
      if (viewerCacheEpoch() !== epoch) return;
      await applyEcho(echo, epoch, picked !== 'remove');
    } catch (e) {
      if (viewerCacheEpoch() !== epoch) return;
      Alert.alert('Couldn’t Update the Cover', errorText(e));
    } finally {
      setCoverBusy(false);
    }
  };

  const add = async (key: MomentAddKey) => {
    setAdding(false);
    if (!draft) return;
    if (key === 'start') return openDate('from', draft);
    if (key === 'end') return openDate('to', draft);
    if (key === 'cover') {
      // The layout turns into the cover hero: no field takes the focus back.
      setFocus(null);
      Keyboard.dismiss();
      const p = await pickPhoto();
      if (!p) return;
      if ('failed' in p) return void Alert.alert('Couldn’t Use That Photo', 'Try another photo.');
      setDraft((x) => (x ? { ...x, cover: p } : x));
      return;
    }
    setDraft((x) => (x ? { ...x, shown: { ...x.shown, [key]: true } } : x));
    setFocus(key);
  };

  // Keyboard + bar clearance (the profile's): the list grows by both while
  // editing, and the focused field is scrolled above them (measured) on
  // focus, on a field switch and as the description grows.
  const [kbH, setKbH] = useState(0);
  const [barH, setBarH] = useState(0);
  useEffect(() => {
    if (!editing) return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, (e) => setKbH(e.endCoordinates.height));
    const h = Keyboard.addListener(hideEvt, () => setKbH(0));
    return () => {
      s.remove();
      h.remove();
      setKbH(0);
    };
  }, [editing]);
  const descLen = draft?.description.length ?? 0;
  useEffect(() => {
    if (!editing || !focusedField || kbH === 0) return;
    const input = refs[focusedField].current;
    const t = setTimeout(() => {
      input?.measureInWindow((_x, y, _w, h) => {
        const over = y + h - (windowH - kbH - barH - 12);
        if (over > 0) scrollBy.current?.(over);
      });
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, focusedField, kbH, barH, descLen, windowH]);

  return {
    draft,
    focus,
    saving,
    coverBusy,
    /** Saving or uploading: the holds wait. */
    busy: saving || coverBusy,
    refs,
    shake,
    adding,
    pick,
    datePick,
    /** The list's bottom padding while editing (0 otherwise; take the max with the pill clearance). */
    bottomInset: editing ? kbH + barH + (kbH > 0 ? 0 : insets.bottom) + 24 : 0,
    /** Spread ALWAYS on the screen's root (see editTouchHandlers). */
    touchHandlers: editTouchHandlers(() => {
      if (editingRef.current) setShake((n) => n + 1);
    }),
    set: (field: MomentTextField, value: string) => {
      if (savingRef.current) return;
      setDraft((d) => (d ? { ...d, [field]: value } : d));
    },
    onFieldFocus: setFocusedField,
    start,
    cancel,
    done,
    changeCover,
    chooseDate: () => {
      if (draft) chooseDate(draft);
    },
    openAdd: (first: MomentAddKey) => {
      setPick(first);
      setAdding(true);
    },
    closeAdd: () => setAdding(false),
    setPick,
    add,
    setBarH,
    pickDate: (value: Date) => setDatePick((p) => (p ? { ...p, value } : p)),
    commitDate: () => {
      const p = datePick;
      setDatePick(null);
      if (!p) return;
      setDraft((x) => (x ? { ...x, [p.which === 'from' ? 'dateFrom' : 'dateTo']: p.value } : x));
    },
    cancelDate: () => setDatePick(null),
  };
}

const ADD_LABELS: Record<MomentAddKey, string> = {
  cover: 'Cover Photo',
  start: 'Start Date',
  end: 'End Time',
  address: 'Address',
  link: 'Event Link',
  description: 'Description',
};

// What Add Fields offers: the details not on screen. The date and the
// optional details live in the about block, which only the Line-up tab shows.
function addOptions(edit: MomentEditApi, hasCover: boolean, lineup: boolean): MomentAddKey[] {
  const d = edit.draft;
  if (!d) return [];
  const out: MomentAddKey[] = [];
  if (!hasCover && !d.cover) out.push('cover');
  if (!lineup) return out;
  if (!d.dateFrom) out.push('start');
  else if (!d.dateTo) out.push('end');
  for (const f of ['address', 'link', 'description'] as const) if (!d.shown[f]) out.push(f);
  return out;
}

// The edit bar for a moment, and the date sheet it opens. Render both on the
// screen root (the bar floats over everything, the sheet is a Modal).
export function MomentEditBar({ edit, hasCover, lineup }: { edit: MomentEditApi; hasCover: boolean; lineup: boolean }) {
  const options = addOptions(edit, hasCover, lineup);
  // Always mounted (it is a Modal: `value` null = hidden, so it slides away).
  const which = edit.datePick?.which ?? 'from';
  const sheet = (
    <DatePickerSheet
      value={edit.datePick?.value ?? null}
      label={which === 'from' ? 'Starts' : 'Ends'}
      minimumDate={which === 'to' ? edit.draft?.dateFrom ?? undefined : undefined}
      maximumDate={which === 'from' ? edit.draft?.dateTo ?? undefined : undefined}
      onChange={edit.pickDate}
      onDone={edit.commitDate}
      onCancel={edit.cancelDate}
      touchCapture={markNoShake}
    />
  );
  if (!edit.draft) return sheet;
  const adding = edit.adding && options.length > 0;
  const pick = options.find((k) => k === edit.pick) ?? options[0];
  const center = adding ? (
    <AddWheel options={options} value={pick} onChange={edit.setPick} />
  ) : options.length > 0 ? (
    <Pressable
      accessibilityRole="button"
      onPress={() => edit.openAdd(options[0])}
      disabled={edit.saving}
      hitSlop={8}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, opacity: pressed || edit.saving ? 0.5 : 1 })}
    >
      <AddGlyph />
      <VText variant="small" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Add Fields</VText>
    </Pressable>
  ) : undefined;
  return (
    <>
      <EditBar
        busy={edit.saving}
        title="Editing Moment"
        center={center}
        doneLabel={adding ? 'Add' : 'Done'}
        onCancel={adding ? edit.closeAdd : edit.cancel}
        onDone={adding ? () => void edit.add(pick) : edit.done}
        onHeight={edit.setBarH}
        shake={edit.shake}
      />
      {sheet}
    </>
  );
}

function AddGlyph() {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  return <Icon name="plus" size={Math.round(phone.text('small').fontSize)} color={theme.accent} />;
}

// The iPhone's own wheel (SwiftUI `Picker`, wheel style): it turns up and
// down, clicks and snaps at each row (the OS's haptics). Three rows show.
// Off iOS (Android, deferred) a tap steps to the next one.
const WHEEL_H = 96;
function AddWheel({ options, value, onChange }: { options: MomentAddKey[]; value: MomentAddKey; onChange: (k: MomentAddKey) => void }) {
  const { theme } = useTheme();
  if (Platform.OS !== 'ios') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Field to add: ${ADD_LABELS[value]}`}
        onPress={() => onChange(options[(options.indexOf(value) + 1) % options.length])}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6 }}
      >
        <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{ADD_LABELS[value]}</VText>
        <Icon name="chevron-down" size={14} color={theme.inkSoft} />
      </Pressable>
    );
  }
  return (
    <Host colorScheme={theme.scheme} style={{ alignSelf: 'stretch', height: WHEEL_H }}>
      <Picker
        selection={value}
        onSelectionChange={(k) => onChange(k as MomentAddKey)}
        modifiers={[pickerStyle('wheel'), labelsHidden(), frame({ height: WHEEL_H }), clipped(), accessibilityLabel('Field to Add')]}
      >
        {options.map((k) => (
          <SwiftText key={k} modifiers={[tag(k)]}>{ADD_LABELS[k]}</SwiftText>
        ))}
      </Picker>
    </Host>
  );
}

// The name on the cover (the white title). A host holds it to edit (a tap
// still opens the cover); while editing it is the field in place, two lines
// like the title.
export function MomentCoverName({ name, edit, onView }: { name: string; edit?: MomentEditApi; onView: () => void }) {
  const phone = usePhoneTokens();
  const title = phone.text('title');
  if (edit?.draft) {
    return (
      <InlineField
        ref={edit.refs.name}
        value={edit.draft.name}
        onChangeText={(s) => edit.set('name', s)}
        onFocus={() => edit.onFieldFocus('name')}
        autoFocus={edit.focus === 'name'}
        multiline
        maxLength={MOMENT_FIELD_MAX.name}
        onSubmit={edit.done}
        accessibilityLabel="Moment Name"
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: title.fontSize, lineHeight: title.lineHeight, letterSpacing: title.letterSpacing, color: '#fff' }}
      />
    );
  }
  const text = (
    <VText numberOfLines={2} style={{ fontFamily: 'InstrumentSans_600SemiBold', ...title, color: '#fff' }}>
      {name}
    </VText>
  );
  if (!edit) return text;
  return (
    <LongPressable swapsOut disabled={edit.busy} onPress={onView} onLongPress={() => edit.start('name')} accessibilityLabel={name} accessibilityHint={MOMENT_EDIT_HINT}>
      {text}
    </LongPressable>
  );
}

// The name in the plain bar (a moment without a cover). Holding it edits;
// while editing it is the field in the title's place, one line like the title.
export function MomentBarName({ name, edit }: { name: string; edit: MomentEditApi }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const subhead = phone.text('subhead');
  if (edit.draft) {
    return (
      <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
        <InlineField
          ref={edit.refs.name}
          value={edit.draft.name}
          onChangeText={(s) => edit.set('name', s)}
          onFocus={() => edit.onFieldFocus('name')}
          autoFocus={edit.focus === 'name'}
          maxLength={MOMENT_FIELD_MAX.name}
          onSubmit={edit.done}
          accessibilityLabel="Moment Name"
          textProps={phone.surface('topBar').textProps}
          style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: subhead.fontSize, letterSpacing: subhead.letterSpacing, color: theme.ink }}
        />
      </View>
    );
  }
  return (
    <LongPressable
      swapsOut
      fill
      disabled={edit.busy}
      onLongPress={() => edit.start('name')}
      accessibilityLabel={name}
      accessibilityHint={MOMENT_EDIT_HINT}
      style={{ flex: 1, minWidth: 0, alignSelf: 'stretch' }}
    >
      <BarTitle title={name} />
    </LongPressable>
  );
}
