using System.Diagnostics.CodeAnalysis;

namespace CineBoutique.Inventory.Api.Models;

/// <summary>
/// Requête de création d'une zone d'inventaire.
/// </summary>
[ExcludeFromCodeCoverage]
public sealed class CreateLocationRequest
{
    public string? Code { get; set; }

    public string? Label { get; set; }
}

/// <summary>
/// Requête de mise à jour d'une zone d'inventaire.
/// </summary>
[ExcludeFromCodeCoverage]
public sealed class UpdateLocationRequest
{
    public string? Code { get; set; }

    public string? Label { get; set; }

    public bool? Disabled { get; set; }
}

/// <summary>
/// Requête de mise à jour du statut d'activation d'une zone.
/// </summary>
[ExcludeFromCodeCoverage]
public sealed class UpdateLocationStatusRequest
{
    public bool? IsActive { get; set; }

    public bool? Force { get; set; }
}
