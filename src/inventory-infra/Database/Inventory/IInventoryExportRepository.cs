using System;
using System.Threading;
using System.Threading.Tasks;

namespace CineBoutique.Inventory.Infrastructure.Database.Inventory;

public interface IInventoryExportRepository
{
    /// <summary>
    /// Lit l'inventaire complet d'une boutique (zones actives, comptages terminés et en cours, lignes comptées).
    /// Renvoie <c>null</c> si la boutique n'existe pas.
    /// </summary>
    Task<InventoryExportSnapshot?> GetSnapshotAsync(Guid shopId, CancellationToken cancellationToken);
}
