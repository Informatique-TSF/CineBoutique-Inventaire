using System;
using System.Threading;
using System.Threading.Tasks;

namespace CineBoutique.Inventory.Infrastructure.Database.Inventory;

public interface IRunRepository
{
    Task<InventorySummaryModel> GetSummaryAsync(Guid shopId, CancellationToken cancellationToken);

    Task<CompletedRunDetailModel?> GetCompletedRunDetailAsync(Guid runId, CancellationToken cancellationToken);

    Task<ActiveRunLookupResult> FindActiveRunAsync(
        Guid locationId,
        short countType,
        Guid ownerUserId,
        Guid? sessionId,
        CancellationToken cancellationToken);
}
