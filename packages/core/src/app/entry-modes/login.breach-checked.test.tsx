/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BreachStatus, Entry } from "../../hooks/useVault";
import { loginMode } from "./login";

afterEach(cleanup);
beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const DAY = 24 * 60 * 60 * 1000;

function renderDetail(breach?: BreachStatus, password = "hunter2", breachChecks = true) {
	const entry = {
		id: "e1",
		type: "login",
		name: "Site",
		urls: [],
		username: "me",
		password,
		breach,
	} as unknown as Entry;
	const Detail = loginMode.Detail;
	render(
		<I18nProvider i18n={i18n}>
			<Detail entry={entry} copied={null} copy={() => {}} breachChecks={breachChecks} />
		</I18nProvider>,
	);
}

describe("login detail: when the password was last checked for breaches", () => {
	it("says how long ago", () => {
		renderDetail({ leaked: false, checkedAt: Date.now() - 3 * DAY });
		expect(screen.getByText("Checked for breaches 3 days ago")).toBeTruthy();
	});

	it("says just now for a fresh result", () => {
		renderDetail({ leaked: false, checkedAt: Date.now() - 5_000 });
		expect(screen.getByText("Checked for breaches just now")).toBeTruthy();
	});

	it("says when there is no result yet", () => {
		renderDetail(undefined);
		expect(screen.getByText("Not checked for breaches yet")).toBeTruthy();
	});

	// Also how a conflict's versions are shown.
	it("says nothing while breach checks are off", () => {
		renderDetail(undefined, "hunter2", false);
		expect(screen.queryByText(/checked for breaches/i)).toBeNull();
	});

	// An empty password is never sent, so "not checked yet" would never change.
	it("says nothing for a login without a password", () => {
		renderDetail(undefined, "");
		expect(screen.queryByText(/checked for breaches/i)).toBeNull();
	});
});
