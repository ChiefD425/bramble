import { Toggle } from "../components/ui/toggle";

interface ToggleRowProps {
	title: string;
	subtitle: string;
	checked: boolean;
	onChange: (next: boolean) => void;
}

/** A setting inside an entry's form: title, one line of explanation, and the switch. */
export function ToggleRow({ title, subtitle, checked, onChange }: ToggleRowProps) {
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0">
				<p className="text-sm">{title}</p>
				<p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
			</div>
			<Toggle checked={checked} onChange={onChange} label={title} />
		</div>
	);
}
