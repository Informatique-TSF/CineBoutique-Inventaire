using System.Globalization;
using ClosedXML.Excel;
using CineBoutique.Inventory.Infrastructure.Database.Inventory;

namespace CineBoutique.Inventory.Api.Features.Inventory.Exports;

/// <summary>
/// Récapitulatif complet des comptages, sur le modèle du classeur « FT - Réconciliation Stock BOUTIQUE » de décembre 2025.
/// Toutes les valeurs sont calculées par l'application (aucune formule) : pas de ligne en double, pas de nombre en texte.
/// </summary>
internal static class CountRecapWorkbookBuilder
{
    internal const string FollowUpSheet = "Suivi";
    internal const string CountsSheet = "Comptages";
    internal const string ControlSheet = "Contrôle par zone";
    internal const string StockSheet = "Stock à importer";
    internal const string ToDoSheet = "À traiter";

    private const string DateTimeFormat = "dd/mm/yyyy hh:mm";

    private static readonly XLColor HeaderColor = XLColor.FromHtml("#DDEBF7");
    private static readonly XLColor OkColor = XLColor.FromHtml("#E2EFDA");
    private static readonly XLColor PendingColor = XLColor.FromHtml("#FCE4D6");
    private static readonly XLColor InProgressColor = XLColor.FromHtml("#FFF2CC");

    public static byte[] Build(
        InventoryExportSnapshot snapshot,
        InventoryReconciliation reconciliation,
        DateTimeOffset exportedAtUtc)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentNullException.ThrowIfNull(reconciliation);

        using var workbook = new XLWorkbook();

        AddFollowUpSheet(workbook, snapshot, reconciliation, exportedAtUtc);
        AddCountsSheet(workbook, snapshot, reconciliation);
        AddControlSheet(workbook, reconciliation);
        AddStockSheet(workbook, reconciliation);
        AddToDoSheet(workbook, reconciliation);

        using var stream = new MemoryStream();
        workbook.SaveAs(stream);
        return stream.ToArray();
    }

    internal static string DescribeResult(ReconciledZoneProduct product)
    {
        ArgumentNullException.ThrowIfNull(product);

        return product.Status switch
        {
            ZoneProductStatus.WaitingBaseline => "En attente des comptages 1 et 2",
            ZoneProductStatus.ToReview => "À revoir : refaire un comptage",
            _ when product.ResolvedAtCountType is null or <= 2 => "OK",
            _ => FormattableString.Invariant($"Résolu au C{product.ResolvedAtCountType}")
        };
    }

    internal static string DescribeExclusion(StockImportExclusion exclusion) => exclusion switch
    {
        StockImportExclusion.None => "Oui",
        StockImportExclusion.ZeroStock => "Non (stock à 0)",
        StockImportExclusion.UnknownProduct => "Non (référence inconnue du catalogue)",
        StockImportExclusion.InvalidSku => "Non (SKU illisible par MCS)",
        StockImportExclusion.PendingReview => "Non (écart ou comptage en attente)",
        _ => "Non"
    };

    private static void AddFollowUpSheet(
        XLWorkbook workbook,
        InventoryExportSnapshot snapshot,
        InventoryReconciliation reconciliation,
        DateTimeOffset exportedAtUtc)
    {
        var sheet = workbook.Worksheets.Add(FollowUpSheet);

        var row = 1;
        WriteLabel(sheet, row, "Boutique", snapshot.ShopName);
        row++;
        WriteLabel(sheet, row, "Code office MCS", snapshot.OfficeCode ?? "non renseigné");
        row++;
        sheet.Cell(row, 1).Value = "Exporté le";
        sheet.Cell(row, 1).Style.Font.Bold = true;
        sheet.Cell(row, 2).Value = ParisTime.FromUtc(exportedAtUtc);
        sheet.Cell(row, 2).Style.NumberFormat.Format = DateTimeFormat;
        sheet.Cell(row, 2).Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Left;
        row++;

        WriteLabel(
            sheet,
            row,
            "État",
            reconciliation.IsComplete
                ? "Inventaire terminé"
                : "Inventaire non terminé : le fichier d'import MCS n'est pas encore disponible");
        sheet.Cell(row, 2).Style.Fill.BackgroundColor = reconciliation.IsComplete ? OkColor : PendingColor;
        row++;

        foreach (var reason in reconciliation.BlockingReasons)
        {
            WriteLabel(sheet, row, "Reste à faire", reason);
            row++;
        }

        row++;

        var statusTypes = reconciliation.CountTypes
            .Concat(reconciliation.Zones.SelectMany(zone => zone.OpenRuns.Select(run => run.CountType)))
            .Concat(reconciliation.Zones
                .Select(zone => zone.NextRequiredCountType)
                .Where(countType => countType.HasValue)
                .Select(countType => countType!.Value))
            .Distinct()
            .OrderBy(countType => countType)
            .ToArray();

        var headers = new List<string> { "Zone" };
        headers.AddRange(statusTypes.Select(countType => FormattableString.Invariant($"C{countType}")));
        headers.Add("Références à revoir");

        var headerRow = row;
        WriteHeader(sheet, headerRow, headers);
        row++;

        foreach (var zone in reconciliation.Zones)
        {
            sheet.Cell(row, 1).Value = InventoryReconciliation.FormatZoneLabel(zone.Zone);

            for (var index = 0; index < statusTypes.Length; index++)
            {
                var countType = statusTypes[index];
                var cell = sheet.Cell(row, index + 2);

                if (zone.OpenRuns.Any(run => run.CountType == countType))
                {
                    cell.Value = "En cours";
                    cell.Style.Fill.BackgroundColor = InProgressColor;
                }
                else if (zone.CompletedRuns.ContainsKey(countType))
                {
                    cell.Value = "OK";
                    cell.Style.Fill.BackgroundColor = OkColor;
                }
                else if (countType <= 2 || countType == zone.NextRequiredCountType)
                {
                    cell.Value = "À compter";
                    cell.Style.Fill.BackgroundColor = PendingColor;
                }
            }

            sheet.Cell(row, statusTypes.Length + 2).Value = zone.ProductsToReview;
            row++;
        }

        sheet.Column(1).Width = 28;
        for (var column = 2; column <= statusTypes.Length + 1; column++)
        {
            sheet.Column(column).Width = 12;
        }

        sheet.Column(statusTypes.Length + 2).Width = 20;
        sheet.SheetView.FreezeRows(headerRow);
    }

    private static void AddCountsSheet(
        XLWorkbook workbook,
        InventoryExportSnapshot snapshot,
        InventoryReconciliation reconciliation)
    {
        var sheet = workbook.Worksheets.Add(CountsSheet);
        var headers = new[] { "Zone", "Comptage", "Opérateur", "Terminé le", "SKU", "EAN", "Libellé", "Quantité" };
        WriteHeader(sheet, 1, headers);

        var linesByRun = snapshot.Lines
            .GroupBy(line => line.RunId)
            .ToDictionary(group => group.Key, group => group.OrderBy(line => line.Sku, StringComparer.OrdinalIgnoreCase).ToArray());

        var row = 2;
        foreach (var zone in reconciliation.Zones)
        {
            var zoneLabel = InventoryReconciliation.FormatZoneLabel(zone.Zone);

            foreach (var run in zone.CompletedRuns.Values.OrderBy(run => run.CountType))
            {
                var runLines = linesByRun.TryGetValue(run.RunId, out var found) ? found : Array.Empty<InventoryExportLine>();

                if (runLines.Length == 0)
                {
                    WriteCountRow(sheet, row, zoneLabel, run, sku: string.Empty, ean: null, name: "(aucune référence)", quantity: 0m);
                    row++;
                    continue;
                }

                foreach (var line in runLines)
                {
                    WriteCountRow(sheet, row, zoneLabel, run, line.Sku.Trim(), line.Ean, line.Name.Trim(), line.Quantity);
                    row++;
                }
            }
        }

        FinishTable(sheet, headers.Length, row - 1, new[] { 24d, 11, 18, 17, 20, 16, 48, 11 });
    }

    private static void WriteCountRow(
        IXLWorksheet sheet,
        int row,
        string zoneLabel,
        InventoryExportRun run,
        string sku,
        string? ean,
        string name,
        decimal quantity)
    {
        sheet.Cell(row, 1).Value = zoneLabel;
        sheet.Cell(row, 2).Value = FormattableString.Invariant($"C{run.CountType}");
        sheet.Cell(row, 3).Value = run.OperatorDisplayName?.Trim() ?? string.Empty;
        sheet.Cell(row, 4).Value = ParisTime.FromUtc(run.CompletedAtUtc);
        sheet.Cell(row, 4).Style.NumberFormat.Format = DateTimeFormat;
        sheet.Cell(row, 5).Value = sku;
        sheet.Cell(row, 6).Value = ean?.Trim() ?? string.Empty;
        sheet.Cell(row, 7).Value = name;
        sheet.Cell(row, 8).Value = (double)quantity;
    }

    private static void AddControlSheet(XLWorkbook workbook, InventoryReconciliation reconciliation)
    {
        var sheet = workbook.Worksheets.Add(ControlSheet);
        var extraCountTypes = reconciliation.CountTypes.Where(countType => countType > 2).ToArray();

        var headers = new List<string> { "Zone", "SKU", "EAN", "Libellé", "C1", "C2", "Écart C1-C2" };
        headers.AddRange(extraCountTypes.Select(countType => FormattableString.Invariant($"C{countType}")));
        headers.Add("Résultat");
        headers.Add("Stock retenu");
        WriteHeader(sheet, 1, headers);

        var row = 2;
        foreach (var zone in reconciliation.Zones)
        {
            var zoneLabel = InventoryReconciliation.FormatZoneLabel(zone.Zone);

            foreach (var product in reconciliation.Products.Where(product => product.Zone.LocationId == zone.Zone.LocationId))
            {
                sheet.Cell(row, 1).Value = zoneLabel;
                sheet.Cell(row, 2).Value = product.Sku;
                sheet.Cell(row, 3).Value = product.Ean ?? string.Empty;
                sheet.Cell(row, 4).Value = product.Name;
                WriteQuantity(sheet.Cell(row, 5), product.DisplayedQuantities, 1);
                WriteQuantity(sheet.Cell(row, 6), product.DisplayedQuantities, 2);

                if (product.GapCount1MinusCount2 is { } gap)
                {
                    sheet.Cell(row, 7).Value = (double)gap;
                }

                for (var index = 0; index < extraCountTypes.Length; index++)
                {
                    WriteQuantity(sheet.Cell(row, 8 + index), product.DisplayedQuantities, extraCountTypes[index]);
                }

                var resultColumn = 8 + extraCountTypes.Length;
                var resultCell = sheet.Cell(row, resultColumn);
                resultCell.Value = DescribeResult(product);
                if (product.Status != ZoneProductStatus.Resolved)
                {
                    resultCell.Style.Fill.BackgroundColor = PendingColor;
                }

                if (product.RetainedQuantity is { } retained)
                {
                    sheet.Cell(row, resultColumn + 1).Value = (double)retained;
                }

                row++;
            }
        }

        var widths = new List<double> { 24, 20, 16, 48, 8, 8, 12 };
        widths.AddRange(extraCountTypes.Select(_ => 8d));
        widths.Add(30);
        widths.Add(13);
        FinishTable(sheet, headers.Count, row - 1, widths);
    }

    private static void WriteQuantity(IXLCell cell, IReadOnlyDictionary<short, decimal> quantities, short countType)
    {
        if (quantities.TryGetValue(countType, out var quantity))
        {
            cell.Value = (double)quantity;
        }
    }

    private static void AddStockSheet(XLWorkbook workbook, InventoryReconciliation reconciliation)
    {
        var sheet = workbook.Worksheets.Add(StockSheet);
        var headers = new[] { "Code", "Libellé", "Stock inventorié", "Dans le fichier d'import MCS" };
        WriteHeader(sheet, 1, headers);

        var row = 2;
        foreach (var stock in reconciliation.Stock)
        {
            sheet.Cell(row, 1).Value = stock.Sku;
            sheet.Cell(row, 2).Value = stock.Name;
            sheet.Cell(row, 3).Value = (double)stock.Quantity;
            sheet.Cell(row, 4).Value = DescribeExclusion(stock.Exclusion);
            if (!stock.IsImported && stock.Exclusion != StockImportExclusion.ZeroStock)
            {
                sheet.Cell(row, 4).Style.Fill.BackgroundColor = PendingColor;
            }

            row++;
        }

        var lastDataRow = row - 1;
        FinishTable(sheet, headers.Length, lastDataRow, new[] { 20d, 52, 16, 38 });

        row++;
        sheet.Cell(row, 1).Value = "Total importé dans MCS";
        sheet.Cell(row, 1).Style.Font.Bold = true;
        sheet.Cell(row, 3).Value = (double)reconciliation.Stock.Where(stock => stock.IsImported).Sum(stock => stock.Quantity);
        sheet.Cell(row, 3).Style.Font.Bold = true;
        sheet.Cell(row, 4).Value = string.Create(
            CultureInfo.InvariantCulture,
            $"{reconciliation.Stock.Count(stock => stock.IsImported)} référence(s)");
    }

    private static void AddToDoSheet(XLWorkbook workbook, InventoryReconciliation reconciliation)
    {
        var toReview = reconciliation.Products.Where(product => product.Status == ZoneProductStatus.ToReview).ToArray();
        var unknown = reconciliation.Stock
            .Where(stock => stock.Exclusion is StockImportExclusion.UnknownProduct or StockImportExclusion.InvalidSku)
            .ToArray();

        if (toReview.Length == 0 && unknown.Length == 0)
        {
            return;
        }

        var sheet = workbook.Worksheets.Add(ToDoSheet);
        var headers = new[] { "Motif", "Zone", "SKU", "EAN", "Libellé", "Détail" };
        WriteHeader(sheet, 1, headers);

        var row = 2;
        foreach (var product in toReview)
        {
            var counts = string.Join(
                " ; ",
                product.DisplayedQuantities
                    .OrderBy(pair => pair.Key)
                    .Select(pair => string.Create(
                        CultureInfo.InvariantCulture,
                        $"C{pair.Key} = {StockImportCsvBuilder.FormatQuantity(pair.Value)}")));

            WriteToDoRow(
                sheet,
                row,
                "Écart non résolu",
                InventoryReconciliation.FormatZoneLabel(product.Zone),
                product,
                $"{counts} : aucune quantité retrouvée deux fois, refaire un comptage de la zone.");
            row++;
        }

        foreach (var stock in unknown)
        {
            var occurrences = reconciliation.Products.Where(product => product.ProductId == stock.ProductId).ToArray();
            var zones = string.Join(", ", occurrences.Select(product => product.Zone.Code).Distinct(StringComparer.OrdinalIgnoreCase));
            var detail = stock.Exclusion == StockImportExclusion.UnknownProduct
                ? $"Code scanné absent du catalogue (quantité retenue : {StockImportCsvBuilder.FormatQuantity(stock.Quantity)}). À rattacher à un vrai SKU et à saisir dans MCS."
                : "Le SKU contient un caractère refusé par MCS (point-virgule, guillemet ou retour à la ligne). À corriger dans le catalogue.";

            WriteToDoRow(
                sheet,
                row,
                stock.Exclusion == StockImportExclusion.UnknownProduct ? "Référence inconnue" : "SKU illisible par MCS",
                zones,
                occurrences.Length > 0 ? occurrences[0] : null,
                detail,
                stock.Sku,
                stock.Name);
            row++;
        }

        FinishTable(sheet, headers.Length, row - 1, new[] { 22d, 24, 20, 16, 44, 80 });
    }

    private static void WriteToDoRow(
        IXLWorksheet sheet,
        int row,
        string reason,
        string zones,
        ReconciledZoneProduct? product,
        string detail,
        string? sku = null,
        string? name = null)
    {
        sheet.Cell(row, 1).Value = reason;
        sheet.Cell(row, 2).Value = zones;
        sheet.Cell(row, 3).Value = sku ?? product?.Sku ?? string.Empty;
        sheet.Cell(row, 4).Value = product?.Ean ?? string.Empty;
        sheet.Cell(row, 5).Value = name ?? product?.Name ?? string.Empty;
        sheet.Cell(row, 6).Value = detail;
    }

    private static void WriteLabel(IXLWorksheet sheet, int row, string label, string value)
    {
        sheet.Cell(row, 1).Value = label;
        sheet.Cell(row, 1).Style.Font.Bold = true;
        sheet.Cell(row, 2).Value = value;
    }

    private static void WriteHeader(IXLWorksheet sheet, int row, IReadOnlyList<string> headers)
    {
        for (var index = 0; index < headers.Count; index++)
        {
            sheet.Cell(row, index + 1).Value = headers[index];
        }

        var range = sheet.Range(row, 1, row, headers.Count);
        range.Style.Font.Bold = true;
        range.Style.Fill.BackgroundColor = HeaderColor;
    }

    private static void FinishTable(IXLWorksheet sheet, int columnCount, int lastRow, IReadOnlyList<double> widths)
    {
        sheet.Range(1, 1, Math.Max(lastRow, 1), columnCount).SetAutoFilter();
        sheet.SheetView.FreezeRows(1);

        for (var index = 0; index < widths.Count && index < columnCount; index++)
        {
            sheet.Column(index + 1).Width = widths[index];
        }
    }
}
