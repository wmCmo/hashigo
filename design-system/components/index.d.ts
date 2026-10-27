import type * as React from 'react';

/** The card: a huge centred headword, its gloss block, then the side's content. */
export interface FlashCardProps extends React.HTMLAttributes<HTMLElement> {
  head?: React.ReactNode;
  /** Defaults by length: ≤2 chars lg (120px), 3–4 md (72px), 5+ sm (44px). */
  headSize?: 'lg' | 'md' | 'sm';
  gloss?: React.ReactNode;
  reading?: React.ReactNode;
  /** Part of speech; rendered uppercase. */
  pos?: React.ReactNode;
  /** One PlayButton, pinned bottom-right. */
  action?: React.ReactNode;
  children?: React.ReactNode;
}
export declare function FlashCard(props: FlashCardProps): React.ReactElement;

export interface ExampleProps { jp?: React.ReactNode; en?: React.ReactNode; children?: React.ReactNode; className?: string }
export declare function Example(props: ExampleProps): React.ReactElement;

export interface ClozeProps { revealed?: boolean; label?: string; children: React.ReactNode }
export declare function Cloze(props: ClozeProps): React.ReactElement;

export interface PlayButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  state?: 'idle' | 'playing' | 'missing';
  size?: 'lg' | 'sm';
  label?: string;
}
export declare function PlayButton(props: PlayButtonProps): React.ReactElement;

export interface CounterProps { value: number; total?: number; idle?: boolean; className?: string }
export declare function Counter(props: CounterProps): React.ReactElement;

export interface WordRailProps { words: string[]; current: number; onSelect?: (index: number) => void; label?: string; className?: string }
export declare function WordRail(props: WordRailProps): React.ReactElement;

export interface MenuButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { label?: string }
export declare function MenuButton(props: MenuButtonProps): React.ReactElement;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  block?: boolean;
  /** Keyboard hint; hidden where there is no hover-capable pointer. */
  kbd?: string | null;
}
export declare function Button(props: ButtonProps): React.ReactElement;

export interface GradeBarProps {
  /** Hidden steps left on the card; 0 shows "remembered". */
  remaining?: number;
  onForgot?: () => void;
  onNext?: () => void;
  onRemembered?: () => void;
  keys?: boolean;
  className?: string;
}
export declare function GradeBar(props: GradeBarProps): React.ReactElement;

export interface ChipProps { tone?: 'neutral' | 'quiet' | 'accent' | 'danger'; lang?: string; children: React.ReactNode; className?: string }
export declare function Chip(props: ChipProps): React.ReactElement;

declare global {
  interface Window {
    Hashigo: {
      FlashCard: typeof FlashCard; Example: typeof Example; Cloze: typeof Cloze; PlayButton: typeof PlayButton;
      Counter: typeof Counter; WordRail: typeof WordRail; MenuButton: typeof MenuButton; Button: typeof Button;
      GradeBar: typeof GradeBar; Chip: typeof Chip;
    };
  }
}
