using System;
using System.Collections.Generic;

namespace CineBoutique.Inventory.Infrastructure.Database.Inventory;

public sealed class InventorySummaryModel
{
    public int ActiveSessions { get; set; }

    public DateTime? LastActivityUtc { get; set; }

    public IReadOnlyList<OpenRunSummaryModel> OpenRuns { get; set; } = Array.Empty<OpenRunSummaryModel>();

    public IReadOnlyList<CompletedRunSummaryModel> CompletedRuns { get; set; } = Array.Empty<CompletedRunSummaryModel>();

    public IReadOnlyList<ConflictZoneSummaryModel> ConflictZones { get; set; } = Array.Empty<ConflictZoneSummaryModel>();
}

public sealed class OpenRunSummaryModel
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

public sealed class CompletedRunSummaryModel
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

public sealed class ConflictZoneSummaryModel
{
    public Guid LocationId { get; set; }

    public string LocationCode { get; set; } = string.Empty;

    public string LocationLabel { get; set; } = string.Empty;

    public int ConflictLines { get; set; }
}

public sealed class CompletedRunDetailModel
{
    public Guid RunId { get; set; }

    public Guid LocationId { get; set; }

    public string LocationCode { get; set; } = string.Empty;

    public string LocationLabel { get; set; } = string.Empty;

    public short CountType { get; set; }

    public string? OperatorDisplayName { get; set; }

    public DateTime StartedAtUtc { get; set; }

    public DateTime CompletedAtUtc { get; set; }

    public IReadOnlyList<CompletedRunLineModel> Items { get; set; } = Array.Empty<CompletedRunLineModel>();
}

public sealed class CompletedRunLineModel
{
    public Guid ProductId { get; set; }

    public string Sku { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string? Ean { get; set; }

    public decimal Quantity { get; set; }
}

public enum ActiveRunLookupStatus
{
    Success,
    NoActiveSession,
    OperatorNotSupported,
    OwnerDisplayNameMissing,
    RunNotFound
}

public sealed class ActiveRunLookupResult
{
    public ActiveRunLookupStatus Status { get; set; }

    public Guid? SessionId { get; set; }

    public ActiveRunModel? Run { get; set; }

    public string? OwnerDisplayName { get; set; }

    public Guid OwnerUserId { get; set; }

    public short CountType { get; set; }
}

public sealed class ActiveRunModel
{
    public Guid RunId { get; set; }

    public Guid LocationId { get; set; }

    public Guid? OwnerUserId { get; set; }

    public string? OperatorDisplayName { get; set; }

    public DateTime StartedAtUtc { get; set; }
}
