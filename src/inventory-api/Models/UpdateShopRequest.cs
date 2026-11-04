using System.ComponentModel.DataAnnotations;

namespace CineBoutique.Inventory.Api.Models;

public sealed class UpdateShopRequest
{
    [Required]
    public Guid Id { get; set; }

    [Required]
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Code « office » MCS (ex. MTP). Absent : le code actuel est conservé. Chaîne vide : le code est effacé.
    /// </summary>
    public string? OfficeCode { get; set; }
}
