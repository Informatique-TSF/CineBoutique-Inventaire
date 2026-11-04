using System.Globalization;
using CineBoutique.Inventory.Infrastructure.Database.Inventory;

namespace CineBoutique.Inventory.Api.Features.Inventory.Exports;

internal enum ZoneProductStatus
{
    /// <summary>Les comptages 1 et 2 de la zone ne sont pas tous les deux terminés.</summary>
    WaitingBaseline,

    /// <summary>Une quantité a été retrouvée deux fois : elle est retenue.</summary>
    Resolved,

    /// <summary>Aucune quantité n'a encore été retrouvée deux fois : il faut un comptage de plus.</summary>
    ToReview
}

internal sealed record ReconciledZoneProduct(
    InventoryExportZone Zone,
    Guid ProductId,
    string Sku,
    string? Ean,
    string Name,
    IReadOnlyDictionary<short, decimal> DisplayedQuantities,
    decimal? GapCount1MinusCount2,
    ZoneProductStatus Status,
    short? ResolvedAtCountType,
    decimal? RetainedQuantity);

internal sealed record ReconciledZone(
    InventoryExportZone Zone,
    IReadOnlyDictionary<short, InventoryExportRun> CompletedRuns,
    IReadOnlyList<InventoryExportOpenRun> OpenRuns,
    int ProductsToReview)
{
    public bool HasBaseline => CompletedRuns.ContainsKey(1) && CompletedRuns.ContainsKey(2);

    public bool IsComplete => HasBaseline && OpenRuns.Count == 0 && ProductsToReview == 0;

    /// <summary>Numéro du prochain comptage à faire pour lever les écarts, s'il y en a.</summary>
    public short? NextRequiredCountType
    {
        get
        {
            if (!HasBaseline || ProductsToReview == 0)
            {
                return null;
            }

            return (short)(CompletedRuns.Keys.Max() + 1);
        }
    }
}

internal enum StockImportExclusion
{
    None,
    ZeroStock,
    UnknownProduct,
    InvalidSku,
    PendingReview
}

internal sealed record ReconciledStock(
    Guid ProductId,
    string Sku,
    string Name,
    decimal Quantity,
    StockImportExclusion Exclusion)
{
    public bool IsImported => Exclusion == StockImportExclusion.None;
}

/// <summary>
/// Calcule, à partir de tous les comptages terminés, la quantité retenue par zone et par référence,
/// puis le stock par référence pour toute la boutique.
/// La règle est celle du moteur de conflits de l'application (SessionRepository.ResolveConflictsForLocationInternalAsync) :
/// on parcourt les comptages dans l'ordre et on retient la première quantité vue deux fois.
/// Une référence absente du comptage 1 ou 2 compte pour 0 dès qu'un 0 a été saisi pour elle dans la zone.
/// </summary>
internal sealed class InventoryReconciliation
{
    internal const string UnknownSkuPrefix = "UNK-";

    private static readonly System.Buffers.SearchValues<char> CharactersRefusedByMcs =
        System.Buffers.SearchValues.Create(";\"\r\n");

    private static readonly short[] BaselineCountTypes = { 1, 2 };

    private InventoryReconciliation(
        IReadOnlyList<short> countTypes,
        IReadOnlyList<ReconciledZone> zones,
        IReadOnlyList<ReconciledZoneProduct> products,
        IReadOnlyList<ReconciledStock> stock,
        IReadOnlyList<string> blockingReasons)
    {
        CountTypes = countTypes;
        Zones = zones;
        Products = products;
        Stock = stock;
        BlockingReasons = blockingReasons;
    }

    /// <summary>Numéros de comptage terminés dans au moins une zone (toujours au moins 1 et 2), triés.</summary>
    public IReadOnlyList<short> CountTypes { get; }

    public IReadOnlyList<ReconciledZone> Zones { get; }

    public IReadOnlyList<ReconciledZoneProduct> Products { get; }

    public IReadOnlyList<ReconciledStock> Stock { get; }

    /// <summary>Raisons pour lesquelles l'inventaire n'est pas terminé. Vide quand il l'est.</summary>
    public IReadOnlyList<string> BlockingReasons { get; }

    public bool IsComplete => BlockingReasons.Count == 0;

    public static InventoryReconciliation Compute(InventoryExportSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);

        var linesByRun = snapshot.Lines
            .GroupBy(line => line.RunId)
            .ToDictionary(group => group.Key, group => group.ToArray());

        var zones = new List<ReconciledZone>(snapshot.Zones.Count);
        var products = new List<ReconciledZoneProduct>();

        foreach (var zone in snapshot.Zones)
        {
            var completedRuns = snapshot.CompletedRuns
                .Where(run => run.LocationId == zone.LocationId)
                .GroupBy(run => run.CountType)
                .ToDictionary(group => group.Key, group => group.OrderByDescending(run => run.CompletedAtUtc).First());

            var openRuns = snapshot.OpenRuns
                .Where(run => run.LocationId == zone.LocationId)
                .OrderBy(run => run.CountType)
                .ToArray();

            var zoneProducts = ReconcileZone(zone, completedRuns, linesByRun);
            products.AddRange(zoneProducts);

            zones.Add(new ReconciledZone(
                zone,
                completedRuns,
                openRuns,
                zoneProducts.Count(product => product.Status == ZoneProductStatus.ToReview)));
        }

        var countTypes = snapshot.CompletedRuns
            .Select(run => run.CountType)
            .Concat(BaselineCountTypes)
            .Where(countType => countType > 0)
            .Distinct()
            .OrderBy(countType => countType)
            .ToArray();

        var stock = BuildStock(products);
        var blockingReasons = BuildBlockingReasons(zones, products);

        return new InventoryReconciliation(countTypes, zones, products, stock, blockingReasons);
    }

    internal static bool IsUnknownProductSku(string sku) =>
        sku.StartsWith(UnknownSkuPrefix, StringComparison.OrdinalIgnoreCase);

    internal static bool IsSkuAcceptedByMcs(string sku) =>
        sku.Length > 0 && sku.AsSpan().IndexOfAny(CharactersRefusedByMcs) < 0;

    internal static string FormatZoneLabel(InventoryExportZone zone)
    {
        ArgumentNullException.ThrowIfNull(zone);

        var code = zone.Code?.Trim() ?? string.Empty;
        var label = zone.Label?.Trim() ?? string.Empty;

        if (code.Length > 0 && label.Length > 0 && !string.Equals(code, label, StringComparison.OrdinalIgnoreCase))
        {
            return $"{code} – {label}";
        }

        return code.Length > 0 ? code : label;
    }

    private static List<ReconciledZoneProduct> ReconcileZone(
        InventoryExportZone zone,
        Dictionary<short, InventoryExportRun> completedRuns,
        Dictionary<Guid, InventoryExportLine[]> linesByRun)
    {
        var doneCountTypes = completedRuns.Keys.OrderBy(countType => countType).ToArray();
        var hasBaseline = completedRuns.ContainsKey(1) && completedRuns.ContainsKey(2);

        var quantitiesByProduct = new Dictionary<Guid, (InventoryExportLine Reference, Dictionary<short, decimal> Quantities)>();

        foreach (var countType in doneCountTypes)
        {
            if (!linesByRun.TryGetValue(completedRuns[countType].RunId, out var runLines))
            {
                continue;
            }

            foreach (var line in runLines)
            {
                if (!quantitiesByProduct.TryGetValue(line.ProductId, out var entry))
                {
                    entry = (line, new Dictionary<short, decimal>());
                    quantitiesByProduct[line.ProductId] = entry;
                }

                entry.Quantities[countType] = entry.Quantities.TryGetValue(countType, out var existing)
                    ? existing + line.Quantity
                    : line.Quantity;
            }
        }

        var results = new List<ReconciledZoneProduct>(quantitiesByProduct.Count);

        foreach (var (productId, (reference, quantities)) in quantitiesByProduct)
        {
            var (status, resolvedAt, retained) = hasBaseline
                ? Resolve(doneCountTypes, quantities)
                : (ZoneProductStatus.WaitingBaseline, (short?)null, (decimal?)null);

            var displayed = BuildDisplayedQuantities(doneCountTypes, quantities);

            decimal? gap = hasBaseline
                ? quantities.GetValueOrDefault((short)1) - quantities.GetValueOrDefault((short)2)
                : null;

            results.Add(new ReconciledZoneProduct(
                zone,
                productId,
                reference.Sku.Trim(),
                string.IsNullOrWhiteSpace(reference.Ean) ? null : reference.Ean.Trim(),
                reference.Name.Trim(),
                displayed,
                gap,
                status,
                resolvedAt,
                retained));
        }

        return results
            .OrderBy(product => product.Sku, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static (ZoneProductStatus Status, short? ResolvedAt, decimal? Retained) Resolve(
        short[] doneCountTypes,
        Dictionary<short, decimal> quantities)
    {
        // Observations réelles, dans l'ordre des comptages.
        var observations = doneCountTypes
            .Where(quantities.ContainsKey)
            .Select(countType => (CountType: countType, Quantity: quantities[countType]))
            .ToList();

        // Absent du comptage 1 ou 2 : compte pour 0 si un 0 a été saisi (même règle que les conflits).
        var missingBaseline = BaselineCountTypes.Where(countType => !quantities.ContainsKey(countType)).ToArray();
        if (missingBaseline.Length > 0 && observations.Any(observation => observation.Quantity == 0m))
        {
            observations.InsertRange(0, missingBaseline.Select(countType => (CountType: countType, Quantity: 0m)));
        }

        var seen = new HashSet<decimal>();
        foreach (var observation in observations)
        {
            if (!seen.Add(observation.Quantity))
            {
                return (ZoneProductStatus.Resolved, observation.CountType, observation.Quantity);
            }
        }

        return (ZoneProductStatus.ToReview, null, null);
    }

    private static Dictionary<short, decimal> BuildDisplayedQuantities(
        short[] doneCountTypes,
        Dictionary<short, decimal> quantities)
    {
        var displayed = new Dictionary<short, decimal>();

        foreach (var countType in doneCountTypes)
        {
            if (quantities.TryGetValue(countType, out var quantity))
            {
                displayed[countType] = quantity;
            }
            else if (countType <= 2)
            {
                // Zone comptée en entier mais référence non trouvée : 0.
                // Au-delà du comptage 2, seules les références en écart sont recomptées : une absence reste vide.
                displayed[countType] = 0m;
            }
        }

        return displayed;
    }

    private static List<ReconciledStock> BuildStock(IReadOnlyList<ReconciledZoneProduct> products)
    {
        return products
            .GroupBy(product => product.ProductId)
            .Select(group =>
            {
                var first = group.First();
                var quantity = group.Sum(product => product.RetainedQuantity ?? 0m);
                var pending = group.Any(product => product.Status != ZoneProductStatus.Resolved);

                var exclusion = IsUnknownProductSku(first.Sku)
                    ? StockImportExclusion.UnknownProduct
                    : !IsSkuAcceptedByMcs(first.Sku)
                        ? StockImportExclusion.InvalidSku
                        : pending
                            ? StockImportExclusion.PendingReview
                            : quantity <= 0m
                                ? StockImportExclusion.ZeroStock
                                : StockImportExclusion.None;

                return new ReconciledStock(first.ProductId, first.Sku, first.Name, quantity, exclusion);
            })
            .OrderBy(stock => stock.Sku, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static List<string> BuildBlockingReasons(
        IReadOnlyList<ReconciledZone> zones,
        IReadOnlyList<ReconciledZoneProduct> products)
    {
        var reasons = new List<string>();

        if (zones.Count == 0)
        {
            reasons.Add("Aucune zone active pour cette boutique.");
            return reasons;
        }

        var missingBaseline = zones
            .Where(zone => !zone.HasBaseline)
            .Select(zone =>
            {
                var missing = BaselineCountTypes
                    .Where(countType => !zone.CompletedRuns.ContainsKey(countType))
                    .Select(countType => FormattableString.Invariant($"C{countType}"));
                return $"{zone.Zone.Code} ({string.Join(", ", missing)})";
            })
            .ToArray();

        if (missingBaseline.Length > 0)
        {
            reasons.Add($"Comptages 1 et 2 à terminer : {JoinWithLimit(missingBaseline)}.");
        }

        var openRuns = zones
            .SelectMany(zone => zone.OpenRuns.Select(run =>
            {
                var operatorLabel = string.IsNullOrWhiteSpace(run.OperatorDisplayName)
                    ? string.Empty
                    : $" par {run.OperatorDisplayName.Trim()}";
                return FormattableString.Invariant($"{zone.Zone.Code} (C{run.CountType}{operatorLabel})");
            }))
            .ToArray();

        if (openRuns.Length > 0)
        {
            reasons.Add($"Comptages en cours : {JoinWithLimit(openRuns)}.");
        }

        var toReview = products
            .Where(product => product.Status == ZoneProductStatus.ToReview)
            .Select(product => $"{product.Sku} en {product.Zone.Code}")
            .ToArray();

        if (toReview.Length > 0)
        {
            var count = toReview.Length.ToString(CultureInfo.InvariantCulture);
            reasons.Add($"{count} référence(s) avec un écart non résolu, à recompter : {JoinWithLimit(toReview)}.");
        }

        return reasons;
    }

    private static string JoinWithLimit(IReadOnlyList<string> values, int limit = 10)
    {
        if (values.Count <= limit)
        {
            return string.Join(", ", values);
        }

        var remaining = (values.Count - limit).ToString(CultureInfo.InvariantCulture);
        return $"{string.Join(", ", values.Take(limit))} et {remaining} autre(s)";
    }
}
