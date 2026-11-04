using System;

namespace CineBoutique.Inventory.Infrastructure.Database.Inventory.InternalRows;

internal sealed class InventorySummaryRow
{
    public int ActiveSessions { get; set; }

    public DateTime? LastActivityUtc { get; set; }
}

internal sealed class OpenRunSummaryRow
{
    public Guid RunId { get; set; }

    public Guid LocationId { get; set; }

    public string LocationCode { get; set; } = string.Empty;

    public string LocationLabel { get; set; } = string.Empty;

    public short CountType { get; set; }

    public Guid? OwnerUserId { get; set; }

    public string? OwnerDisplayName { get; set; }

    public DateTime StartedAtUtc { get; set; }
}

internal sealed class CompletedRunSummaryRow
{
    public Guid RunId { get; set; }

    public Guid LocationId { get; set; }

    public string LocationCode { get; set; } = string.Empty;

    public string LocationLabel { get; set; } = string.Empty;

    public short CountType { get; set; }

    public Guid? OwnerUserId { get; set; }

    public string? OwnerDisplayName { get; set; }

    public DateTime StartedAtUtc { get; set; }

    public DateTime CompletedAtUtc { get; set; }
}

internal sealed class ConflictZoneSummaryRow
{
    public Guid LocationId { get; set; }

    public string LocationCode { get; set; } = string.Empty;

    public string LocationLabel { get; set; } = string.Empty;

    public int ConflictLines { get; set; }
}

internal sealed class CompletedRunDetailRow
{
    public Guid RunId { get; set; }

    public Guid LocationId { get; set; }

    public string LocationCode { get; set; } = string.Empty;

    public string LocationLabel { get; set; } = string.Empty;

    public short CountType { get; set; }

    public string? OperatorDisplayName { get; set; }

    public DateTime StartedAtUtc { get; set; }

    public DateTime CompletedAtUtc { get; set; }
}

internal sealed class CompletedRunLineRow
{
    public Guid ProductId { get; set; }

    public string Sku { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string? Ean { get; set; }

    public decimal Quantity { get; set; }
}

internal sealed class ActiveRunRow
{
    public Guid RunId { get; set; }

    public Guid LocationId { get; set; }

    public Guid? OwnerUserId { get; set; }

    public string? OperatorDisplayName { get; set; }

    public DateTime StartedAtUtc { get; set; }
}
