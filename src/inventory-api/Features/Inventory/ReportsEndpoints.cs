using System.Globalization;
using System.Text;
using CineBoutique.Inventory.Api.Endpoints;
using CineBoutique.Inventory.Api.Features.Inventory.Exports;
using CineBoutique.Inventory.Api.Infrastructure.Time;
using CineBoutique.Inventory.Infrastructure.Database.Inventory;
using Microsoft.AspNetCore.Mvc;

namespace CineBoutique.Inventory.Api.Features.Inventory;

/// <summary>
/// Exports de fin d'inventaire : le fichier d'import de stock MCS et le récapitulatif complet des comptages.
/// Les deux reposent sur tous les comptages terminés de chaque zone, pas seulement le dernier.
/// </summary>
internal static class ReportsEndpoints
{
    internal const string StockImportRoute = "/api/shops/{shopId:guid}/reports/inventory/stock-import.csv";
    internal const string CountRecapRoute = "/api/shops/{shopId:guid}/reports/inventory/recap.xlsx";

    private const string XlsxContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    public static IEndpointRouteBuilder MapReportsEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet(StockImportRoute, async (
            Guid shopId,
            IInventoryExportRepository exportRepository,
            IClock clock,
            CancellationToken cancellationToken) =>
        {
            var snapshot = await exportRepository.GetSnapshotAsync(shopId, cancellationToken).ConfigureAwait(false);
            if (snapshot is null)
            {
                return ShopNotFound();
            }

            if (string.IsNullOrWhiteSpace(snapshot.OfficeCode))
            {
                return EndpointUtilities.Problem(
                    "Code office manquant",
                    $"La boutique « {snapshot.ShopName} » n'a pas de code office MCS. Renseignez-le dans Admin > Boutique.",
                    StatusCodes.Status409Conflict);
            }

            var reconciliation = InventoryReconciliation.Compute(snapshot);
            if (!reconciliation.IsComplete)
            {
                return EndpointUtilities.Problem(
                    "Inventaire non terminé",
                    $"Le fichier d'import MCS sera disponible quand l'inventaire sera terminé. {string.Join(" ", reconciliation.BlockingReasons)}",
                    StatusCodes.Status409Conflict,
                    new Dictionary<string, object?> { ["reasons"] = reconciliation.BlockingReasons });
            }

            var now = clock.UtcNow;
            var exportDate = ParisTime.FromUtc(now);
            var content = StockImportCsvBuilder.Build(snapshot.OfficeCode, reconciliation.Stock, exportDate);
            var fileName = string.Create(
                CultureInfo.InvariantCulture,
                $"import-stock-{snapshot.OfficeCode}-{Slugify(snapshot.ShopName)}-{exportDate:yyyyMMdd}.csv");

            return Results.File(content, "text/csv; charset=utf-8", fileName);
        })
        .WithName("DownloadStockImportCsv")
        .WithTags("Reports")
        .WithOpenApi(operation =>
        {
            operation.Summary = "Fichier d'import de stock MCS";
            operation.Description = "Une ligne par référence (stock > 0) au format office;item_id;loc_total_invent;locd_trans_date;locd_trans_cost. Refusé (409) tant que l'inventaire n'est pas terminé ou que la boutique n'a pas de code office.";
            return operation;
        })
        .Produces(StatusCodes.Status200OK, contentType: "text/csv")
        .Produces<ProblemDetails>(StatusCodes.Status404NotFound)
        .Produces<ProblemDetails>(StatusCodes.Status409Conflict);

        app.MapGet(CountRecapRoute, async (
            Guid shopId,
            IInventoryExportRepository exportRepository,
            IClock clock,
            CancellationToken cancellationToken) =>
        {
            var snapshot = await exportRepository.GetSnapshotAsync(shopId, cancellationToken).ConfigureAwait(false);
            if (snapshot is null)
            {
                return ShopNotFound();
            }

            var reconciliation = InventoryReconciliation.Compute(snapshot);
            var now = clock.UtcNow;
            var content = CountRecapWorkbookBuilder.Build(snapshot, reconciliation, now);

            var prefix = string.IsNullOrWhiteSpace(snapshot.OfficeCode) ? string.Empty : $"{snapshot.OfficeCode}-";
            var fileName = string.Create(
                CultureInfo.InvariantCulture,
                $"recap-comptages-{prefix}{Slugify(snapshot.ShopName)}-{ParisTime.FromUtc(now):yyyyMMdd-HHmm}.xlsx");

            return Results.File(content, XlsxContentType, fileName);
        })
        .WithName("DownloadCountRecapXlsx")
        .WithTags("Reports")
        .WithOpenApi(operation =>
        {
            operation.Summary = "Récapitulatif complet des comptages (Excel)";
            operation.Description = "Suivi des zones, toutes les lignes de tous les comptages, contrôle par zone avec la quantité retenue, stock à importer. Disponible à tout moment, même en cours d'inventaire.";
            return operation;
        })
        .Produces(StatusCodes.Status200OK, contentType: XlsxContentType)
        .Produces<ProblemDetails>(StatusCodes.Status404NotFound);

        return app;
    }

    private static IResult ShopNotFound() =>
        EndpointUtilities.Problem("Boutique introuvable", "Aucune boutique ne correspond à cet identifiant.", StatusCodes.Status404NotFound);

    internal static string Slugify(string value)
    {
        var normalized = (value ?? string.Empty).Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(normalized.Length);
        var previousWasDash = false;

        foreach (var character in normalized)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(character) == UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            if (char.IsAsciiLetterOrDigit(character))
            {
                builder.Append(char.ToLowerInvariant(character));
                previousWasDash = false;
            }
            else if (!previousWasDash && builder.Length > 0)
            {
                builder.Append('-');
                previousWasDash = true;
            }
        }

        var slug = builder.ToString().Trim('-');
        return slug.Length > 0 ? slug : "boutique";
    }
}
