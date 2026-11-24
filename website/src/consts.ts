export const SITE = {
	name: "Bramble",
	domain: "bramble.sh",
	url: "https://bramble.sh",
	tagline: "A password manager that syncs between your devices",
	description:
		"Bramble syncs your passwords between your phone, computer and browser. Everything is end-to-end encrypted. Your passwords are saved only on your devices, not on a server. You do not need an account, and only you can open your vault.",
	contactEmail: "support@bramble.sh",
} as const;

export const LINKS = {
	github: "https://github.com/bramble-sh/bramble",
	chrome: "https://chromewebstore.google.com/detail/bramble/kmokhdhoggbdcgoepifeckhgbfakaknm",
	firefox: "https://addons.mozilla.org/firefox/addon/bramble/",
	ios: "https://apps.apple.com/us/app/bramble-password-manager/id6783071787",
	android: "https://github.com/bramble-sh/bramble/releases",
	matrix: "https://matrix.to/#/%23general:bramble.sh",
	kofi: "https://ko-fi.com/bramble_sh",
} as const;

// The /donate page's wallets: the same addresses as the app's Settings → About → Support
// (packages/core/src/app/screens/Settings/components/SupportSection.tsx), so change both together.
// Each `qr` image in public/qr encodes the payment URI the app's QR does; redraw it if an address
// changes.
export const WALLETS = [
	{
		name: "Monero",
		address:
			"4AC3txuTwFm4fkamoYeK47c9EpnPwbreHNxJeKDYHiDNN6weD5vVA4BCH1azQhSxa6JjereuVpt21Pu2MyRDFDNNH6KGnWq",
		qr: "/qr/monero.svg",
	},
	{
		name: "Bitcoin Lightning",
		address: "flythenimbus@cake.cash",
		qr: "/qr/bitcoin-lightning.svg",
	},
	{
		name: "Bitcoin on-chain",
		address: "bc1q78sd5rnuufqdtv9plp0p56hrq72c9unj8tec8t",
		qr: "/qr/bitcoin.svg",
	},
] as const;

export const BUTTONDOWN = {
	// Buttondown username (Settings -> Embedding). The newsletter form POSTs to
	// buttondown.com/api/emails/embed-subscribe/<username>.
	username: "bramble.sh",
} as const;

export const NAV = [
	{ label: "Screenshots", href: "/#screenshots" },
	{ label: "Features", href: "/#features" },
	{ label: "Security", href: "/#security" },
	{ label: "Docs", href: "/docs" },
	{ label: "Blog", href: "/blog" },
	{ label: "FAQ", href: "/#faq" },
] as const;
