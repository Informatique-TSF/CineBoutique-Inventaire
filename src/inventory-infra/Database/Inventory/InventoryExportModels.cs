using System;
using System.Collections.Generic;

namespace CineBoutique.Inventory.Infrastructure.Database.Inventory;

/// <summary>
/// Photographie brute d'un inventaire de boutique, telle que lue en base, pour les exports de fin d'inventaire.
/// Elle contient tous les comptages terminés (le dernier par zone et par numéro de comptage), pas seulement le dernier de la zone.
/// </summary>
public sealed class InventoryExportSnapshot
{
    public Guid ShopId { get; init; }

    public string ShopName { get; init; } = string.Empty;

    public string? OfficeCode { get; init; }

    public IReadOnlyList<InventoryExportZone> Zones { get; init; } = Array.Empty<InventoryExportZone>();

    public IReadOnlyList<InventoryExportRun> CompletedRuns { get; init; } = Array.Empty<InventoryExportRun>();

    public IReadOnlyList<InventoryExportOpenRun> OpenRuns { get; init; } = Array.Empty<InventoryExportOpenRun>();

    public IReadOnlyList<InventoryExportLine> Lines { get; init; } = Array.Empty<InventoryExportLine>();
}

public sealed class InventoryExportZone
{
    public Guid LocationId { get; set; }

    public string Code { get; set; } = string.Empty;

    public string Label { get; set; } = string.Empty;
}

public sealed class InventoryExportRun
{
    public Guid RunId { get; set; }

    public Guid LocationId { get; set; }

    public short CountType { get; set; }

    public DateTime CompletedAtUtc { get; set; }

    public string? OperatorDisplayName { get; set; }
}

public sealed class InventoryExportOpenRun
{
    public Guid LocationId { get; set; }

    public short CountType { get; set; }

    public string? OperatorDisplayName { get; set; }
}

public sealed class InventoryExportLine
{
    public Guid RunId { get; set; }

    public Guid ProductId { get; set; }

    public string Sku { get; set; } = string.Empty;

    public string? Ean { get; set; }

    public string Name { get; set; } = string.Empty;

    public decimal Quantity { get; set; }
}
