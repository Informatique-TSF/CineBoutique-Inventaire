import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateShop } from "../../../api/adminApi";
import { ShopSettingsPanel } from "../ShopSettingsPanel";

import { fetchShops } from "@/api/shops";
import { ShopProvider } from "@/state/ShopContext";
import type { Shop } from "@/types/shop";

vi.mock("@/api/shops", () => ({
  fetchShops: vi.fn(),
}));

vi.mock("../../../api/adminApi", () => ({
  updateShop: vi.fn(),
}));

const mockedFetchShops = vi.mocked(fetchShops);
const mockedUpdateShop = vi.mocked(updateShop);

const shop: Shop = {
  id: "shop-mtp",
  name: "CinéBoutique Montpellier",
  kind: "boutique",
};

const renderPanel = () =>
  render(
    <ShopProvider>
      <ShopSettingsPanel description="Code office MCS de la boutique." />
    </ShopProvider>
  );

const officeCodeInput = () => screen.getByLabelText("Code office MCS");

describe("ShopSettingsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cb.shop", JSON.stringify(shop));
    mockedFetchShops.mockReset();
    mockedUpdateShop.mockReset();
  });

  it("affiche le code office actuel et enregistre la modification en majuscules", async () => {
    mockedFetchShops.mockResolvedValue([{ ...shop, officeCode: "MTP" }]);
    mockedUpdateShop.mockResolvedValue({ ...shop, officeCode: "BEG" });
    const user = userEvent.setup();

    renderPanel();

    await waitFor(() => expect(officeCodeInput()).toHaveValue("MTP"));
    const saveButton = screen.getByRole("button", { name: "Enregistrer" });
    expect(saveButton).toBeDisabled();

    await user.clear(officeCodeInput());
    await user.type(officeCodeInput(), "beg");
    expect(officeCodeInput()).toHaveValue("BEG");

    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() =>
      expect(mockedUpdateShop).toHaveBeenCalledWith({
        id: "shop-mtp",
        name: "CinéBoutique Montpellier",
        officeCode: "BEG",
      })
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Code office enregistré : BEG."
    );
    expect(JSON.parse(localStorage.getItem("cb.shop") ?? "{}")).toMatchObject({
      id: "shop-mtp",
      officeCode: "BEG",
    });
  });

  it("refuse un code contenant un caractère interdit", async () => {
    mockedFetchShops.mockResolvedValue([{ ...shop, officeCode: null }]);
    const user = userEvent.setup();

    renderPanel();

    await waitFor(() => expect(mockedFetchShops).toHaveBeenCalled());
    await waitFor(() => expect(officeCodeInput()).toHaveValue(""));
    await user.type(officeCodeInput(), "M;");

    expect(
      screen.getByText("Le code doit contenir de 2 à 16 lettres ou chiffres.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    expect(mockedUpdateShop).not.toHaveBeenCalled();
  });

  it("affiche l’erreur renvoyée par l’API", async () => {
    mockedFetchShops.mockResolvedValue([{ ...shop, officeCode: "MTP" }]);
    mockedUpdateShop.mockRejectedValue(new Error("Accès refusé."));
    const user = userEvent.setup();

    renderPanel();

    await waitFor(() => expect(officeCodeInput()).toHaveValue("MTP"));
    await user.clear(officeCodeInput());
    await user.type(officeCodeInput(), "SDB");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Accès refusé.");
  });
});
