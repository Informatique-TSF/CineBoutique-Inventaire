import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

import { updateShop } from "../../api/adminApi";
import { Card } from "../../components/Card";
import { LoadingIndicator } from "../../components/LoadingIndicator";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";

import { fetchShops } from "@/api/shops";
import { useShop } from "@/state/ShopContext";

const OFFICE_CODE_PATTERN = /^[A-Z0-9]{2,16}$/;

type Feedback = { type: "success" | "error"; message: string } | null;

type ShopSettingsPanelProps = {
  description: string;
};

const normalizeOfficeCode = (value: string) => value.trim().toUpperCase();

export const ShopSettingsPanel = ({ description }: ShopSettingsPanelProps) => {
  const { shop, setShop } = useShop();
  const shopId = shop?.id?.trim() ?? "";
  const [officeCode, setOfficeCode] = useState("");
  const [savedOfficeCode, setSavedOfficeCode] = useState("");
  const [serverName, setServerName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    if (!shopId) {
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setFeedback(null);

    fetchShops({ signal: controller.signal })
      .then((shops) => {
        const current = shops.find((candidate) => candidate.id === shopId);
        const code = current?.officeCode?.trim() ?? "";
        setOfficeCode(code);
        setSavedOfficeCode(code);
        setServerName(current?.name ?? null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setFeedback({
          type: "error",
          message:
            error instanceof Error && error.message
              ? error.message
              : "Impossible de charger la boutique.",
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [shopId]);

  const normalized = normalizeOfficeCode(officeCode);
  const isValid = normalized.length === 0 || OFFICE_CODE_PATTERN.test(normalized);
  const hasChanges = normalized !== savedOfficeCode;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!shop || !isValid || !hasChanges) {
        return;
      }

      setSaving(true);
      setFeedback(null);
      try {
        // Nom relu sur le serveur : évite d'annuler un renommage fait depuis un autre poste.
        const updated = await updateShop({
          id: shop.id,
          name: serverName ?? shop.name,
          officeCode: normalized,
        });
        const code = updated.officeCode?.trim() ?? "";
        setOfficeCode(code);
        setSavedOfficeCode(code);
        setServerName(updated.name);
        setShop({ ...shop, name: updated.name, officeCode: code || null });
        setFeedback({
          type: "success",
          message: code
            ? `Code office enregistré : ${code}.`
            : "Code office effacé : le fichier d’import MCS sera refusé pour cette boutique.",
        });
      } catch (error) {
        setFeedback({
          type: "error",
          message:
            error instanceof Error && error.message
              ? error.message
              : "Impossible d’enregistrer le code office.",
        });
      } finally {
        setSaving(false);
      }
    },
    [hasChanges, isValid, normalized, serverName, setShop, shop]
  );

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
          Boutique
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {description}
        </p>
      </div>
      {loading ? (
        <LoadingIndicator label="Chargement de la boutique" />
      ) : (
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <p className="text-sm text-slate-700 dark:text-slate-200">
            <span className="font-semibold">Nom :</span>{" "}
            {shop?.name ?? "Boutique non sélectionnée"}
          </p>
          <Input
            name="officeCode"
            label="Code office MCS"
            value={officeCode}
            onChange={(event) => setOfficeCode(event.target.value.toUpperCase())}
            maxLength={16}
            autoComplete="off"
            placeholder="ex. MTP"
            helpText="Colonne « office » du fichier d’import de stock MCS. En province, la boutique et la lumière partagent le même code ; à Saint-Denis : SDB pour la boutique, SDL pour la lumière."
            aria-invalid={!isValid}
          />
          {!isValid && (
            <p className="text-sm text-rose-700 dark:text-rose-300">
              Le code doit contenir de 2 à 16 lettres ou chiffres.
            </p>
          )}
          {feedback && (
            <p
              role={feedback.type === "error" ? "alert" : "status"}
              className={
                feedback.type === "error"
                  ? "rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100"
                  : "rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
              }
            >
              {feedback.message}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={!shop || !isValid || !hasChanges || saving}>
              {saving ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
};
