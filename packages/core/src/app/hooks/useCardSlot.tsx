import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

interface CardSlot {
	/** A card was closed or acted on during this open. */
	closed: boolean;
	close(): void;
}

const CardSlotContext = createContext<CardSlot>({ closed: false, close: () => {} });

/**
 * The vault list's one spot for a card, kept empty for the rest of an open once a card is closed.
 * Provided by AppLayout, which mounts once per open: each popup on the extension, each unlock
 * elsewhere (a lock leaves the layout for the unlock screen). See docs/whats-new.md.
 */
export function CardSlotProvider({ children }: { children: ReactNode }) {
	const [closed, setClosed] = useState(false);
	const value = useMemo(() => ({ closed, close: () => setClosed(true) }), [closed]);
	return <CardSlotContext.Provider value={value}>{children}</CardSlotContext.Provider>;
}

export function useCardSlot(): CardSlot {
	return useContext(CardSlotContext);
}
